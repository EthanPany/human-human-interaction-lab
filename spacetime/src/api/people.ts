import { avatarOf } from "../lib/avatar";
import { canonicalPair, connectionOf, latestConversation, log, meetingsOf, nowMs, otherOf, pairKey } from "../lib/db";
import type { Tx, User } from "../schema";
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

/**
 * The People tab: everyone I saved or met in person, newest first.
 * `connectedAt` is when they joined the list (saved, or first met); `saved`
 * says whether I saved their contact.
 */
export function list(ctx: Ctx, args: Record<string, unknown>) {
  const { tx } = ctx;
  const userId = str(args, "userId");
  const entries = new Map<string, { at: number; saved: boolean }>();
  for (const m of meetingsOf(tx, userId)) entries.set(otherOf(m, userId), { at: m.firstAt, saved: false });
  for (const c of tx.db.connections.owner.filter(userId)) {
    const seen = entries.get(c.other);
    entries.set(c.other, { at: seen ? Math.min(seen.at, c.at) : c.at, saved: true });
  }
  const out = [];
  for (const [otherId, entry] of entries) {
    const other = publicProfile(ctx, tx.db.users.id.find(otherId));
    if (!other) continue;
    const convo = latestConversation(tx, userId, otherId);
    out.push({ ...other, connectedAt: entry.at, saved: entry.saved, lastSummary: convo?.summary });
  }
  return out.sort((x, y) => y.connectedAt - x.connectedAt);
}

/** One person: profile, latest conversation summary, my follow up, timeline. */
export function detail(ctx: Ctx, args: Record<string, unknown>) {
  const { tx } = ctx;
  const userId = str(args, "userId");
  const otherId = str(args, "otherId");
  const other = publicProfile(ctx, tx.db.users.id.find(otherId));
  if (!other) return null;
  const pair = canonicalPair(userId, otherId);
  const convo = latestConversation(tx, userId, otherId);
  const timeline = [...tx.db.activity.owner.filter(userId)].filter((t) => t.other === otherId).sort((x, y) => x.at - y.at);
  const connection = connectionOf(tx, userId, otherId);
  const meeting = tx.db.meetings.id.find(pairKey(userId, otherId));
  return {
    person: other,
    connectedAt: connection?.at,
    saved: Boolean(connection),
    metAt: meeting?.firstAt,
    conversation: convo
      ? {
          startedAt: convo.startedAt,
          endedAt: convo.endedAt,
          summary: convo.summary,
          topics: convo.topics ?? [],
          followUp: pair.a === userId ? convo.followUpForA : convo.followUpForB,
        }
      : null,
    timeline: timeline.map((t) => ({ kind: t.kind, text: t.text, at: t.at })),
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
