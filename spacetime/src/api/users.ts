import type { Tx, User } from "../schema";
import { normalizePhone } from "../lib/phone";
import { avatarOf, defaultAvatar } from "../lib/avatar";
import { dropsShortEncounters, newId, nowMs, queueText, requestRescore, respondFromOf, scheduleLineCheck, UserError } from "../lib/db";
import { normalizeHandle } from "../lib/photonApi";
import { ArgError, optStr, str, type Ctx } from "./context";

/** Port of backend/convex/users.ts. */

/** Profile fields the app and the agent are allowed to edit (users.profilePatch). */
const STRING_FIELDS = [
  "name", "headline", "company", "location", "lookingFor", "offers", "appearance",
  "avatarShape", "avatarColor", "badgeLayout",
] as const;
const LIST_FIELDS = ["tags", "hobbies"] as const;
const BOOL_FIELDS = ["californiaMode", "recordConversations"] as const;
/** respondFromM and dropShortEncounters live in the user_prefs table but use the same patch. */
export type ProfilePatch = Partial<Pick<User, (typeof STRING_FIELDS)[number] | (typeof LIST_FIELDS)[number] | (typeof BOOL_FIELDS)[number]>> & {
  respondFromM?: number;
  dropShortEncounters?: boolean;
};

/** Validate a patch like the Convex `profilePatch` validator (unknown keys are rejected). */
export function parsePatch(raw: unknown): ProfilePatch {
  if (!raw || typeof raw !== "object") throw new ArgError("patch must be an object");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if ((STRING_FIELDS as readonly string[]).includes(k)) {
      if (typeof v !== "string") throw new ArgError(`patch.${k} must be a string`);
    } else if ((LIST_FIELDS as readonly string[]).includes(k)) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ArgError(`patch.${k} must be a list of strings`);
    } else if ((BOOL_FIELDS as readonly string[]).includes(k) || k === "dropShortEncounters") {
      if (typeof v !== "boolean") throw new ArgError(`patch.${k} must be a boolean`);
    } else if (k === "respondFromM") {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new ArgError(`patch.${k} must be a number`);
    } else {
      throw new ArgError(`patch has an unknown field ${k}`);
    }
    out[k] = v;
  }
  return out as ProfilePatch;
}

/** Fields that change who someone matches with. Editing others skips re-scoring. */
const MATCHING_FIELDS = ["name", "headline", "company", "tags", "lookingFor", "offers", "hobbies"] as const;

export function touchesMatching(patch: Record<string, unknown>) {
  return MATCHING_FIELDS.some((k) => patch[k] !== undefined);
}

export function applyPatch(tx: Tx, userId: string, patch: ProfilePatch) {
  const u = tx.db.users.id.find(userId);
  if (!u) throw new UserError("No such user");
  const { respondFromM, dropShortEncounters, ...profile } = patch;
  if (Object.keys(profile).length) tx.db.users.id.update({ ...u, ...profile });
  if (respondFromM !== undefined || dropShortEncounters !== undefined) {
    const prefs = tx.db.userPrefs.userId.find(userId);
    const row = {
      userId,
      respondFromM: respondFromM ?? prefs?.respondFromM,
      dropShortEncounters: dropShortEncounters ?? prefs?.dropShortEncounters,
    };
    if (prefs) tx.db.userPrefs.userId.update(row);
    else tx.db.userPrefs.insert(row);
  }
  if (touchesMatching(patch)) requestRescore(tx, userId);
}

export function userByPhone(tx: Tx, phone: string) {
  return tx.db.users.phone.find(normalizePhone(phone));
}

/** A new, empty account row. */
export function blankUser(id: string, phone: string): User {
  return {
    id,
    phone,
    password: undefined,
    name: undefined,
    headline: undefined,
    company: undefined,
    location: undefined,
    tags: undefined,
    lookingFor: undefined,
    offers: undefined,
    hobbies: undefined,
    appearance: undefined,
    californiaMode: true,
    recordConversations: true,
    lastSeenAt: undefined,
    profileUpdatedAt: undefined,
    avatarShape: undefined,
    avatarColor: undefined,
    badgeLayout: undefined,
    photoId: undefined,
  };
}

/** The signed in person's own view of their profile (no password). Same keys as Convex. */
function ownProfile(ctx: Ctx, u: User) {
  const { id, password, photoId, ...rest } = u;
  const avatar = avatarOf({ _id: id, avatarShape: u.avatarShape, avatarColor: u.avatarColor });
  return {
    _id: id,
    ...rest,
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    badgeLayout: u.badgeLayout ?? "avatar",
    photoUrl: ctx.photoUrl(photoId),
    hasPassword: Boolean(password),
    // Settings > Nearby and Recording (user_prefs)
    respondFromM: respondFromOf(ctx.tx, id),
    dropShortEncounters: dropsShortEncounters(ctx.tx, id),
    // The Photon iMessage line this person texts (assigned on sign in, api/photonAssign.ts)
    agentLine: ctx.tx.db.agentLines.phone.find(u.phone)?.line,
    // False until they text their agent line once. The app then says
    // "Text your agent to start" (a shared iMessage line can't text first).
    agentConnected: Boolean(ctx.tx.db.photonConversations.phone.find(normalizeHandle(u.phone))),
  };
}

export function signIn({ tx }: Ctx, args: Record<string, unknown>) {
  const phone = normalizePhone(str(args, "phone"));
  const name = optStr(args, "name");
  const password = optStr(args, "password");
  if (phone.replace(/\D/g, "").length < 10) throw new UserError("Enter a full phone number");
  const existing = tx.db.users.phone.find(phone);
  if (existing) {
    if (existing.password && existing.password !== password) throw new UserError("Wrong password");
    if (name && !existing.name) tx.db.users.id.update({ ...existing, name });
    // Every sign in checks their Photon line (adds them if missing, fixes a stale one)
    scheduleLineCheck(tx, existing.id);
    return existing.id;
  }
  const id = newId(tx);
  tx.db.users.insert({
    ...blankUser(id, phone),
    name,
    password: password || undefined,
    lastSeenAt: nowMs(tx),
    badgeLayout: "avatar",
    ...defaultAvatar(phone),
  });
  // Put them on the iMessage line right away so texting the agent just works
  scheduleLineCheck(tx, id);
  // Sent as soon as they first text the line (a shared line can't text first).
  // If their first text gets a direct answer, the agent greets them there instead.
  queueText(
    tx,
    phone,
    name
      ? `Hi ${name}, I'm your badge agent. I'll help you meet the right people at the event and remember who you met. Quick question to get you set up: what do you do?`
      : "Hi, I'm your badge agent. I'll help you meet the right people at the event and remember who you met. What should I call you?",
    "welcome",
  );
  return id;
}

export function me(ctx: Ctx, args: Record<string, unknown>) {
  const u = ctx.tx.db.users.id.find(str(args, "userId"));
  return u ? ownProfile(ctx, u) : null;
}

export function updateProfile({ tx }: Ctx, args: Record<string, unknown>) {
  applyPatch(tx, str(args, "userId"), parsePatch(args.patch));
  return null;
}

/** The app calls this every 30 seconds while open: "I'm at the event". */
export function heartbeat({ tx }: Ctx, args: Record<string, unknown>) {
  const u = tx.db.users.id.find(str(args, "userId"));
  if (u) tx.db.users.id.update({ ...u, lastSeenAt: nowMs(tx) });
  return null;
}

// Photos ---------------------------------------------------------------------
// Upload flow: POST /upload with the JPEG -> { storageId } -> setPhoto/addMoment.

/** Insert photo bytes (called by the /upload route). */
export function storePhoto(tx: Tx, data: Uint8Array, contentType: string) {
  const id = newId(tx);
  tx.db.photos.insert({ id, contentType, data, at: nowMs(tx) });
  return id;
}

function deletePhoto(tx: Tx, photoId: string | undefined) {
  if (photoId) tx.db.photos.id.delete(photoId);
}

/** Badge photo. Pass no storageId to remove it. */
export function setPhoto({ tx }: Ctx, args: Record<string, unknown>) {
  const u = tx.db.users.id.find(str(args, "userId"));
  if (!u) throw new UserError("No such user");
  const storageId = optStr(args, "storageId");
  if (storageId && !tx.db.photos.id.find(storageId)) throw new ArgError("Unknown storageId");
  if (u.photoId && u.photoId !== storageId) deletePhoto(tx, u.photoId);
  tx.db.users.id.update({
    ...u,
    photoId: storageId,
    badgeLayout: storageId ? (u.badgeLayout === "avatar" ? "photoText" : u.badgeLayout) : "avatar",
  });
  return null;
}

export function moments(ctx: Ctx, args: Record<string, unknown>) {
  const rows = [...ctx.tx.db.moments.owner.filter(str(args, "userId"))].sort((x, y) => y.at - x.at).slice(0, 30);
  return rows.map((m) => ({ id: m.id, caption: m.caption, at: m.at, url: ctx.photoUrl(m.photoId) }));
}

export function addMoment({ tx }: Ctx, args: Record<string, unknown>) {
  const storageId = str(args, "storageId");
  if (!tx.db.photos.id.find(storageId)) throw new ArgError("Unknown storageId");
  tx.db.moments.insert({ id: newId(tx), owner: str(args, "userId"), photoId: storageId, caption: optStr(args, "caption"), at: nowMs(tx) });
  return null;
}

export function removeMoment({ tx }: Ctx, args: Record<string, unknown>) {
  const m = tx.db.moments.id.find(str(args, "momentId"));
  if (!m || m.owner !== str(args, "userId")) return null;
  deletePhoto(tx, m.photoId);
  tx.db.moments.id.delete(m.id);
  return null;
}
