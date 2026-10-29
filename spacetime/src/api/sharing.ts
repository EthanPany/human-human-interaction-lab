import { avatarOf } from "../lib/avatar";
import { directedKey, log, newId, nowMs, queueText, UserError } from "../lib/db";
import type { Tx } from "../schema";
import { ArgError, optStr, str, type Ctx } from "./context";
import { haveMet } from "./notify";
import { profilePhotoIdOf } from "./profilePhoto";

/**
 * Contact sharing. Nothing is shared automatically: each person keeps a list
 * of things they could share ("What I share": links, handles, email, phone,
 * images such as a QR code), and shares them with someone only through a
 * request the other person answers.
 *
 *   sharing:request    {userId, otherId, kind: "offer" | "ask", itemIds?}  -> {requestId}
 *                      offer: I share my items (default: my preselected ones); ask: I ask for theirs.
 *   sharing:respond    {userId, requestId, approve, itemIds?}               -> {status}
 *                      ask: itemIds are what I share back (default: my preselected ones).
 *                      offer: approving accepts their items; itemIds (optional) shares mine back.
 *   sharing:cancel     {userId, requestId}         the sender takes a pending request back
 *   sharing:revoke     {userId, otherId, itemIds?} stop sharing (some or all) of mine with them
 *   sharing:handshake  {userId, otherId, itemIds?, source?}                 -> {status, requestId, expiresAt?}
 *                      Apple Watch (Phase 6): each side calls it after approving on their own
 *                      watch. The first call waits (status "waiting", up to 2 minutes); the
 *                      second completes a mutual share (status "complete") with each side's items.
 *
 * Reads (polled by the app): sharing:items (mine), sharing:inbox (requests
 * waiting for me), sharing:with (what we share with each other, and pending
 * requests both ways). Requests need the two to have met (an encounter, a
 * meeting or a saved contact), except the handshake, which is itself an in
 * person meeting. A new request also queues one short iMessage nudge to the
 * recipient (outbox kind "share", paced like every other agent text, dropped
 * once the request is answered, at most one per pair per hour, expires after
 * 30 minutes).
 */

export const SHARE_KINDS = ["linkedin", "website", "github", "x", "instagram", "email", "phone", "link", "image"] as const;
type ShareKind = (typeof SHARE_KINDS)[number];

const KIND_NAMES: Record<ShareKind, string> = {
  linkedin: "LinkedIn",
  website: "Website",
  github: "GitHub",
  x: "X",
  instagram: "Instagram",
  email: "Email",
  phone: "Phone",
  link: "Link",
  image: "Image",
};

export const MAX_SHARE_ITEMS = 20;
const MAX_VALUE_LENGTH = 300;
const MAX_LABEL_LENGTH = 40;
/** Both watches must approve within this long of each other. */
export const HANDSHAKE_WINDOW_MS = 2 * 60_000;
/** A nudge text that has not gone out by then is dropped. */
const NUDGE_TTL_MS = 30 * 60_000;
/** At most one nudge text per sender and recipient in this window. */
const NUDGE_COOLDOWN_MS = 60 * 60_000;

// Arguments ------------------------------------------------------------------

function bool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  if (typeof v !== "boolean") throw new ArgError(`Argument ${key} must be a boolean`);
  return v;
}

function optIds(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ArgError(`Argument ${key} must be a list of strings`);
  return [...new Set(v as string[])];
}

function clip(s: string | undefined, max: number) {
  const t = s?.trim();
  return t ? t.slice(0, max) : undefined;
}

// Links ----------------------------------------------------------------------

function stripAt(v: string) {
  return v.replace(/^@+/, "");
}

function withScheme(v: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}

/** The link the app opens for an item (handles become profile URLs). */
export function linkFor(kind: string, value: string | undefined) {
  if (!value) return undefined;
  const v = value.trim();
  const isUrl = /^(https?:\/\/|www\.)/i.test(v) || /\.[a-z]{2,}\//i.test(v);
  switch (kind) {
    case "linkedin":
      return isUrl || v.includes("linkedin.com") ? withScheme(v) : `https://www.linkedin.com/in/${encodeURIComponent(stripAt(v))}`;
    case "github":
      return isUrl || v.includes("github.com") ? withScheme(v) : `https://github.com/${encodeURIComponent(stripAt(v))}`;
    case "x":
      return isUrl || /(^|\.)(x|twitter)\.com/.test(v) ? withScheme(v) : `https://x.com/${encodeURIComponent(stripAt(v))}`;
    case "instagram":
      return isUrl || v.includes("instagram.com") ? withScheme(v) : `https://www.instagram.com/${encodeURIComponent(stripAt(v))}`;
    case "email":
      return `mailto:${v.replace(/^mailto:/i, "")}`;
    case "phone":
      return `tel:${v.replace(/[^\d+]/g, "")}`;
    case "website":
    case "link":
      return withScheme(v);
    default:
      return undefined;
  }
}

// Views ----------------------------------------------------------------------

type Item = NonNullable<ReturnType<Tx["db"]["shareItems"]["id"]["find"]>>;
type Request = NonNullable<ReturnType<Tx["db"]["shareRequests"]["id"]["find"]>>;

function itemsOf(tx: Tx, owner: string) {
  return [...tx.db.shareItems.owner.filter(owner)].sort((x, y) => x.position - y.position || x.updatedAt - y.updatedAt);
}

function itemView(ctx: Ctx, i: Item) {
  return {
    id: i.id,
    kind: i.kind,
    label: i.label ?? KIND_NAMES[i.kind as ShareKind] ?? "Link",
    value: i.value,
    url: linkFor(i.kind, i.value),
    photoUrl: ctx.photoUrl(i.photoId),
    includeByDefault: i.includeByDefault,
  };
}

/** What an offer shows before it is accepted: kinds and names only, no values. */
function previewView(i: Item) {
  return { id: i.id, kind: i.kind, label: i.label ?? KIND_NAMES[i.kind as ShareKind] ?? "Link" };
}

/** Items of `owner` by id, in the owner's order, skipping deleted ones. */
function resolve(tx: Tx, owner: string, ids: readonly string[]) {
  const wanted = new Set(ids);
  return itemsOf(tx, owner).filter((i) => wanted.has(i.id));
}

function personView(ctx: Ctx, userId: string) {
  const u = ctx.tx.db.users.id.find(userId);
  if (!u) return null;
  const avatar = avatarOf({ _id: u.id, avatarShape: u.avatarShape, avatarColor: u.avatarColor });
  return {
    id: u.id,
    name: u.name,
    headline: u.headline,
    company: u.company,
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    profilePhotoUrl: ctx.photoUrl(profilePhotoIdOf(ctx.tx, u.id)),
  };
}

function requestView(ctx: Ctx, r: Request) {
  return {
    id: r.id,
    kind: r.kind,
    createdAt: r.createdAt,
    source: r.source,
    items: r.kind === "offer" ? resolve(ctx.tx, r.sender, r.itemIds).map(previewView) : [],
  };
}

// Grants -----------------------------------------------------------------------

export function grantOf(tx: Tx, owner: string, viewer: string) {
  return tx.db.shareGrants.id.find(directedKey(owner, viewer));
}

/** Does `owner` share anything (still existing) with `viewer`? (people:list flags) */
export function sharesWith(tx: Tx, owner: string, viewer: string) {
  const g = grantOf(tx, owner, viewer);
  return Boolean(g && resolve(tx, owner, g.itemIds).length);
}

/** Add items to what `owner` shares with `viewer`. Returns how many are shared now. */
function grant(tx: Tx, owner: string, viewer: string, ids: readonly string[]) {
  const valid = resolve(tx, owner, ids).map((i) => i.id);
  if (!valid.length) return 0;
  const now = nowMs(tx);
  const existing = grantOf(tx, owner, viewer);
  const itemIds = [...new Set([...(existing?.itemIds ?? []), ...valid])];
  if (existing) tx.db.shareGrants.id.update({ ...existing, itemIds, updatedAt: now });
  else tx.db.shareGrants.insert({ id: directedKey(owner, viewer), owner, viewer, itemIds, at: now, updatedAt: now });
  return itemIds.length;
}

function nameOf(tx: Tx, userId: string) {
  return tx.db.users.id.find(userId)?.name ?? "them";
}

function logShared(tx: Tx, owner: string, viewer: string, count: number) {
  if (!count) return;
  const things = count === 1 ? "1 item" : `${count} items`;
  log(tx, owner, viewer, "shared", `You shared ${things} with ${nameOf(tx, viewer)}`);
  log(tx, viewer, owner, "shared", `${nameOf(tx, owner)} shared ${things} with you`);
}

/** My preselected items (the default for a share). */
function defaultIds(tx: Tx, owner: string) {
  return itemsOf(tx, owner).filter((i) => i.includeByDefault).map((i) => i.id);
}

// Items --------------------------------------------------------------------------

/** sharing:items {userId}: my shareable items, in order. */
export function items(ctx: Ctx, args: Record<string, unknown>) {
  return itemsOf(ctx.tx, str(args, "userId")).map((i) => itemView(ctx, i));
}

/** sharing:saveItem {userId, item: {id?, kind, label?, value?, storageId?, includeByDefault?}} -> id */
export function saveItem({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  if (!tx.db.users.id.find(userId)) throw new UserError("No such user");
  const raw = args.item;
  if (!raw || typeof raw !== "object") throw new ArgError("item must be an object");
  const item = raw as Record<string, unknown>;
  const kind = str(item, "kind");
  if (!(SHARE_KINDS as readonly string[]).includes(kind)) throw new ArgError(`Unknown kind ${kind}`);
  const id = optStr(item, "id");
  const existing = id ? tx.db.shareItems.id.find(id) : undefined;
  if (id && (!existing || existing.owner !== userId)) throw new ArgError("Unknown item");
  if (!existing && [...tx.db.shareItems.owner.filter(userId)].length >= MAX_SHARE_ITEMS) {
    throw new UserError(`You can share up to ${MAX_SHARE_ITEMS} things.`);
  }
  const label = clip(optStr(item, "label"), MAX_LABEL_LENGTH);
  const value = clip(optStr(item, "value"), MAX_VALUE_LENGTH);
  const storageId = optStr(item, "storageId");
  let photoId = existing?.photoId;
  if (kind === "image") {
    if (storageId) {
      if (!tx.db.photos.id.find(storageId)) throw new ArgError("Unknown storageId");
      if (photoId && photoId !== storageId) tx.db.photos.id.delete(photoId);
      photoId = storageId;
    }
    if (!photoId) throw new UserError("Pick an image to share.");
  } else {
    if (!value) throw new UserError(`Add your ${KIND_NAMES[kind as ShareKind]} first.`);
    if (kind === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.replace(/^mailto:/i, ""))) {
      throw new UserError("That email address doesn't look right.");
    }
    if (kind === "phone" && value.replace(/\D/g, "").length < 7) throw new UserError("That phone number looks too short.");
    if (photoId) tx.db.photos.id.delete(photoId);
    photoId = undefined;
  }
  const includeByDefault = typeof item.includeByDefault === "boolean" ? item.includeByDefault : (existing?.includeByDefault ?? true);
  const now = nowMs(tx);
  const row = {
    id: existing?.id ?? newId(tx),
    owner: userId,
    kind,
    label,
    value: kind === "image" ? undefined : value,
    photoId,
    includeByDefault,
    position: existing?.position ?? now,
    updatedAt: now,
  };
  if (existing) tx.db.shareItems.id.update(row);
  else tx.db.shareItems.insert(row);
  return row.id;
}

/** sharing:removeItem {userId, itemId}: gone everywhere it was shared, too. */
export function removeItem({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const i = tx.db.shareItems.id.find(str(args, "itemId"));
  if (!i || i.owner !== userId) return null;
  if (i.photoId) tx.db.photos.id.delete(i.photoId);
  tx.db.shareItems.id.delete(i.id);
  for (const g of [...tx.db.shareGrants.owner.filter(userId)]) {
    if (!g.itemIds.includes(i.id)) continue;
    const itemIds = g.itemIds.filter((x) => x !== i.id);
    if (itemIds.length) tx.db.shareGrants.id.update({ ...g, itemIds, updatedAt: nowMs(tx) });
    else tx.db.shareGrants.id.delete(g.id);
  }
  return null;
}

/** sharing:reorder {userId, itemIds}: the list order. */
export function reorder({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const ids = optIds(args, "itemIds") ?? [];
  ids.forEach((id, index) => {
    const i = tx.db.shareItems.id.find(id);
    if (i && i.owner === userId && i.position !== index) tx.db.shareItems.id.update({ ...i, position: index });
  });
  return null;
}

// Requests -------------------------------------------------------------------------

function pendingFrom(tx: Tx, sender: string, recipient: string, kind?: string) {
  return [...tx.db.shareRequests.sender.filter(sender)].find(
    (r) => r.recipient === recipient && r.status === "pending" && (kind === undefined || r.kind === kind),
  );
}

function close(tx: Tx, r: Request, status: string) {
  tx.db.shareRequests.id.update({ ...r, status, respondedAt: nowMs(tx) });
}

/** One short text to the recipient, paced by the agent's outbox like every other text. */
function nudge(tx: Tx, r: Request) {
  const recipient = tx.db.users.id.find(r.recipient);
  if (!recipient) return;
  const pair = directedKey(r.sender, r.recipient);
  const now = nowMs(tx);
  if ([...tx.db.shareNudges.pair.filter(pair)].some((n) => now - n.at < NUDGE_COOLDOWN_MS)) return;
  const name = tx.db.users.id.find(r.sender)?.name ?? "Someone you met";
  const body =
    r.kind === "offer"
      ? `${name} wants to share their contact info with you. Open People in the badge app to accept or decline.`
      : `${name} asked for your contact info. Open People in the badge app to pick what to share, or decline.`;
  const outboxId = queueText(tx, recipient.phone, body, undefined, { kind: "share", expiresAt: now + NUDGE_TTL_MS });
  if (outboxId) tx.db.shareNudges.insert({ outboxId, requestId: r.id, pair, at: now });
}

/**
 * The agent's outbox asks before sending a share nudge (api/cloudAgent.ts):
 * once the request is answered or taken back, the text is dropped.
 */
export function shareNudgeStillUseful(tx: Tx, outboxId: string) {
  const n = tx.db.shareNudges.outboxId.find(outboxId);
  if (!n) return true;
  return tx.db.shareRequests.id.find(n.requestId)?.status === "pending";
}

/** sharing:request {userId, otherId, kind, itemIds?} -> {requestId} */
export function request({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const otherId = str(args, "otherId");
  const kind = str(args, "kind");
  if (kind !== "offer" && kind !== "ask") throw new ArgError("kind must be offer or ask");
  if (userId === otherId) throw new ArgError("Can't share with yourself");
  if (!tx.db.users.id.find(userId) || !tx.db.users.id.find(otherId)) throw new UserError("No such user");
  if (!haveMet(tx, userId, otherId)) throw new UserError("You can share only with people you've met.");

  let itemIds: string[] = [];
  if (kind === "offer") {
    const picked = optIds(args, "itemIds");
    itemIds = resolve(tx, userId, picked ?? defaultIds(tx, userId)).map((i) => i.id);
    if (!itemIds.length) {
      throw new UserError(itemsOf(tx, userId).length ? "Pick at least one thing to share." : "Add what you share in Settings first.");
    }
  }

  const existing = pendingFrom(tx, userId, otherId, kind);
  if (existing) {
    if (kind === "offer") tx.db.shareRequests.id.update({ ...existing, itemIds });
    return { requestId: existing.id };
  }
  const now = nowMs(tx);
  const r = { id: newId(tx), sender: userId, recipient: otherId, kind, itemIds, status: "pending", source: "app", createdAt: now, respondedAt: undefined };
  tx.db.shareRequests.insert(r);
  log(tx, userId, otherId, "share", kind === "offer" ? `Offered to share your info with ${nameOf(tx, otherId)}` : `Asked ${nameOf(tx, otherId)} for their info`);
  nudge(tx, r);
  return { requestId: r.id };
}

/** sharing:respond {userId, requestId, approve, itemIds?} -> {status} */
export function respond({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const r = tx.db.shareRequests.id.find(str(args, "requestId"));
  if (!r || r.recipient !== userId || r.kind === "handshake") throw new ArgError("Unknown request");
  if (r.status !== "pending") return { status: r.status };
  if (!bool(args, "approve")) {
    close(tx, r, "declined");
    return { status: "declined" };
  }
  const picked = optIds(args, "itemIds");
  if (r.kind === "ask") {
    const ids = resolve(tx, userId, picked ?? defaultIds(tx, userId)).map((i) => i.id);
    if (!ids.length) throw new UserError(itemsOf(tx, userId).length ? "Pick at least one thing to share." : "Add what you share in Settings first.");
    grant(tx, userId, r.sender, ids);
    logShared(tx, userId, r.sender, ids.length);
  } else {
    grant(tx, r.sender, userId, r.itemIds);
    logShared(tx, r.sender, userId, resolve(tx, r.sender, r.itemIds).length);
    // Accepting an offer can share mine back in the same tap
    if (picked?.length) {
      grant(tx, userId, r.sender, picked);
      logShared(tx, userId, r.sender, resolve(tx, userId, picked).length);
    }
  }
  close(tx, r, "approved");
  return { status: "approved" };
}

/** sharing:cancel {userId, requestId}: the sender takes it back. */
export function cancel({ tx }: Ctx, args: Record<string, unknown>) {
  const r = tx.db.shareRequests.id.find(str(args, "requestId"));
  if (r && r.sender === str(args, "userId") && r.status === "pending") close(tx, r, "cancelled");
  return null;
}

/** sharing:revoke {userId, otherId, itemIds?}: stop sharing these (default: everything) with them. */
export function revoke({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const otherId = str(args, "otherId");
  const g = grantOf(tx, userId, otherId);
  if (!g) return null;
  const drop = optIds(args, "itemIds");
  const itemIds = drop ? g.itemIds.filter((id) => !drop.includes(id)) : [];
  if (itemIds.length) tx.db.shareGrants.id.update({ ...g, itemIds, updatedAt: nowMs(tx) });
  else {
    tx.db.shareGrants.id.delete(g.id);
    log(tx, userId, otherId, "share", `Stopped sharing your info with ${nameOf(tx, otherId)}`);
  }
  return null;
}

/**
 * sharing:handshake {userId, otherId, itemIds?, source?}: one half of a mutual
 * share, after this person approved it (on their Apple Watch, Phase 6). The
 * first call waits for the other; the second, within 2 minutes, shares both
 * ways at once (each side's itemIds, default their preselected items).
 */
export function handshake({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const otherId = str(args, "otherId");
  if (userId === otherId) throw new ArgError("Can't share with yourself");
  if (!tx.db.users.id.find(userId) || !tx.db.users.id.find(otherId)) throw new UserError("No such user");
  const source = optStr(args, "source") ?? "watch";
  const now = nowMs(tx);
  const mine = resolve(tx, userId, optIds(args, "itemIds") ?? defaultIds(tx, userId)).map((i) => i.id);

  // Old halves that nobody completed
  for (const r of [...tx.db.shareRequests.sender.filter(userId), ...tx.db.shareRequests.sender.filter(otherId)]) {
    if (r.kind === "handshake" && r.status === "pending" && now - r.createdAt > HANDSHAKE_WINDOW_MS) close(tx, r, "expired");
  }

  const theirs = pendingFrom(tx, otherId, userId, "handshake");
  if (theirs) {
    const sharedWithMe = resolve(tx, otherId, theirs.itemIds).length;
    grant(tx, otherId, userId, theirs.itemIds);
    grant(tx, userId, otherId, mine);
    logShared(tx, otherId, userId, sharedWithMe);
    logShared(tx, userId, otherId, mine.length);
    close(tx, theirs, "approved");
    const own = pendingFrom(tx, userId, otherId, "handshake");
    if (own) close(tx, own, "approved");
    return { status: "complete", requestId: theirs.id, sharedByMe: mine.length, sharedWithMe };
  }

  const own = pendingFrom(tx, userId, otherId, "handshake");
  if (own) {
    tx.db.shareRequests.id.update({ ...own, itemIds: mine, createdAt: now });
    return { status: "waiting", requestId: own.id, expiresAt: now + HANDSHAKE_WINDOW_MS };
  }
  const id = newId(tx);
  tx.db.shareRequests.insert({ id, sender: userId, recipient: otherId, kind: "handshake", itemIds: mine, status: "pending", source, createdAt: now, respondedAt: undefined });
  return { status: "waiting", requestId: id, expiresAt: now + HANDSHAKE_WINDOW_MS };
}

// Reads ---------------------------------------------------------------------------

/** sharing:inbox {userId}: offers and asks waiting for my answer, newest first. */
export function inbox(ctx: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  return [...ctx.tx.db.shareRequests.recipient.filter(userId)]
    .filter((r) => r.status === "pending" && r.kind !== "handshake")
    .sort((x, y) => y.createdAt - x.createdAt)
    .map((r) => ({ ...requestView(ctx, r), from: personView(ctx, r.sender) }))
    .filter((r) => r.from);
}

/**
 * sharing:with {userId, otherId}: what they share with me (live items), which
 * of mine they can see, and pending requests both ways.
 */
export function withPerson(ctx: Ctx, args: Record<string, unknown>) {
  const { tx } = ctx;
  const userId = str(args, "userId");
  const otherId = str(args, "otherId");
  const theirGrant = grantOf(tx, otherId, userId);
  const myGrant = grantOf(tx, userId, otherId);
  const incoming = [...tx.db.shareRequests.sender.filter(otherId)].find((r) => r.recipient === userId && r.status === "pending" && r.kind !== "handshake");
  const outgoing = [...tx.db.shareRequests.sender.filter(userId)].find((r) => r.recipient === otherId && r.status === "pending" && r.kind !== "handshake");
  const lastDeclined = [...tx.db.shareRequests.sender.filter(userId)]
    .filter((r) => r.recipient === otherId && r.status === "declined")
    .reduce<number | undefined>((m, r) => Math.max(m ?? 0, r.respondedAt ?? 0), undefined);
  return {
    theirs: theirGrant ? resolve(tx, otherId, theirGrant.itemIds).map((i) => itemView(ctx, i)) : [],
    sharedWithMeAt: theirGrant?.at,
    mine: myGrant ? resolve(tx, userId, myGrant.itemIds).map((i) => i.id) : [],
    sharedByMeAt: myGrant?.at,
    incoming: incoming ? requestView(ctx, incoming) : null,
    outgoing: outgoing ? requestView(ctx, outgoing) : null,
    lastDeclinedAt: lastDeclined,
  };
}

/** Forget sharing between the two e2e test users, and their items (testing:resetTestPair only). */
export function resetSharing(tx: Tx, x: string, y: string) {
  for (const owner of [x, y]) {
    for (const i of [...tx.db.shareItems.owner.filter(owner)]) {
      if (i.photoId) tx.db.photos.id.delete(i.photoId);
      tx.db.shareItems.id.delete(i.id);
    }
  }
  for (const [a, b] of [[x, y], [y, x]]) {
    tx.db.shareGrants.id.delete(directedKey(a, b));
    for (const r of [...tx.db.shareRequests.sender.filter(a)]) if (r.recipient === b) tx.db.shareRequests.id.delete(r.id);
    for (const n of [...tx.db.shareNudges.pair.filter(directedKey(a, b))]) tx.db.shareNudges.outboxId.delete(n.outboxId);
  }
}
