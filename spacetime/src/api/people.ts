import { avatarOf } from "../lib/avatar";
import { canonicalPair, connectionOf, conversationsOf, log, meetingsOf, nowMs, otherOf, pairKey } from "../lib/db";
import type { Conversation, Tx, User } from "../schema";
import { hiddenFrom, togetherMs } from "./conversations";
import { str, type Ctx } from "./context";

/** Port of backend/convex/people.ts (the People tab and the iPhone Duo). */

/** Public profile fields only (no phone, no password). */
function publicProfile(ctx: Ctx, u: User | null) {
  if (!u) return null;
  const avatar = avatarOf({ _id: u.id, avatarShape: u.avatarShape, avatarColor: u.avatarColor });
  return {
    id: u.id,
    name: u.name,
    headline: u.headline,
    company: u.company,
    location: u.location,
    tags: u.tags ?? [],
    hobbies: u.hobbies ?? [],
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    photoUrl: ctx.photoUrl(u.photoId),
  };
}

/**
 * Record that a matched pair met in person (came within talking distance).
 * Idempotent: the first time adds a "Met" line to both timelines and puts each
 * person in the other's People list; later calls only bump lastAt.
 */
export function markMet(tx: Tx, x: string, y: string) {
  if (x === y) return;
  const { a, b } = canonicalPair(x, y);
  const id = pairKey(a, b);
  const now = nowMs(tx);
  const existing = tx.db.meetings.id.find(id);
  if (existing) {
    if (now - existing.lastAt > 5_000) tx.db.meetings.id.update({ ...existing, lastAt: now });
    return;
  }
  tx.db.meetings.insert({ id, a, b, firstAt: now, lastAt: now });
  const ua = tx.db.users.id.find(a);
  const ub = tx.db.users.id.find(b);
  log(tx, a, b, "met", `Met ${ub?.name ?? "them"}`);
  log(tx, b, a, "met", `Met ${ua?.name ?? "them"}`);
}

/** The phone calls this at the "we finally met" moment (its own UWB reading). */
export function met({ tx }: Ctx, args: Record<string, unknown>) {
  markMet(tx, str(args, "userId"), str(args, "otherId"));
  return null;
}

/** My encounters with this person that I can see, newest first. */
function encountersWith(tx: Tx, userId: string, otherId: string) {
  return [...tx.db.conversations.pair.filter(pairKey(userId, otherId))]
    .filter((c) => !hiddenFrom(tx, c, userId))
    .sort((x, y) => y.startedAt - x.startedAt);
}

/** One encounter as the app shows it. */
function encounterView(tx: Tx, c: Conversation, userId: string) {
  const e = tx.db.encounters.conversationId.find(c.id);
  return {
    id: c.id,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    durationMs: togetherMs(tx, c),
    matched: e?.matched ?? true,
    summary: c.summary,
    topics: c.topics ?? [],
    followUp: c.a === userId ? c.followUpForA : c.followUpForB,
  };
}

function minutes(ms: number) {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : m === 1 ? "1 min" : `${m} min`;
}

/**
 * The People tab: everyone I saved, met in person (matches) or had an
 * encounter with (anyone), newest first. `connectedAt` is when they joined the
 * list; `saved` says whether I saved their contact.
 */
export function list(ctx: Ctx, args: Record<string, unknown>) {
  const { tx } = ctx;
  const userId = str(args, "userId");
  const entries = new Map<string, { at: number; saved: boolean }>();
  const add = (other: string, at: number, saved: boolean) => {
    const seen = entries.get(other);
    entries.set(other, { at: seen ? Math.min(seen.at, at) : at, saved: saved || (seen?.saved ?? false) });
  };
  for (const m of meetingsOf(tx, userId)) add(otherOf(m, userId), m.firstAt, false);
  for (const c of conversationsOf(tx, userId)) if (!hiddenFrom(tx, c, userId)) add(otherOf(c, userId), c.startedAt, false);
  for (const c of tx.db.connections.owner.filter(userId)) add(c.other, c.at, true);
  const out = [];
  for (const [otherId, entry] of entries) {
    const other = publicProfile(ctx, tx.db.users.id.find(otherId));
    if (!other) continue;
    const lastSummary = encountersWith(tx, userId, otherId).find((c) => c.summary)?.summary;
    out.push({ ...other, connectedAt: entry.at, saved: entry.saved, lastSummary });
  }
  return out.sort((x, y) => y.connectedAt - x.connectedAt);
}

/**
 * One person: profile, every encounter (each with its own summary and my
 * follow up, newest first), and the timeline. `conversation` is the latest
 * encounter, for older apps.
 */
export function detail(ctx: Ctx, args: Record<string, unknown>) {
  const { tx } = ctx;
  const userId = str(args, "userId");
  const otherId = str(args, "otherId");
  const other = publicProfile(ctx, tx.db.users.id.find(otherId));
  if (!other) return null;
  const encounters = encountersWith(tx, userId, otherId).map((c) => encounterView(tx, c, userId));
  // Encounters replace the "Talked with" lines (dropped ones leave no trace)
  const logged = [...tx.db.activity.owner.filter(userId)]
    .filter((t) => t.other === otherId && t.kind !== "talked")
    .map((t) => ({ kind: t.kind, text: t.text, at: t.at }));
  const talked = encounters.map((e) => ({
    kind: "talked",
    text: e.endedAt === undefined ? "Talking now" : `Talked for ${minutes(e.durationMs)}`,
    at: e.startedAt,
  }));
  const timeline = [...logged, ...talked].sort((x, y) => x.at - y.at);
  const connection = connectionOf(tx, userId, otherId);
  const meeting = tx.db.meetings.id.find(pairKey(userId, otherId));
  const latest = encounters[0];
  return {
    person: other,
    connectedAt: connection?.at,
    saved: Boolean(connection),
    metAt: meeting?.firstAt ?? encounters[encounters.length - 1]?.startedAt,
    conversation: latest
      ? { startedAt: latest.startedAt, endedAt: latest.endedAt, summary: latest.summary, topics: latest.topics, followUp: latest.followUp }
      : null,
    encounters,
    timeline,
  };
}

/**
 * For the iPhone Duo: who to show when it opens. The person I'm talking with
 * or most recently met, talked with or saved; heads ups and intros don't count.
 */
export function current({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  let latest: { at: number; other?: string } | undefined;
  for (const a of tx.db.activity.owner.filter(userId)) {
    if (a.kind !== "met" && a.kind !== "talked" && a.kind !== "saved") continue;
    if (!latest || a.at >= latest.at) latest = a;
  }
  return latest?.other ?? null;
}
