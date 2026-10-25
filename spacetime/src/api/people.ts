import { avatarOf } from "../lib/avatar";
import { canonicalPair, connectionOf, latestConversation } from "../lib/db";
import type { User } from "../schema";
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

/** The People tab: everyone I saved, newest first. */
export function list(ctx: Ctx, args: Record<string, unknown>) {
  const { tx } = ctx;
  const userId = str(args, "userId");
  const conns = [...tx.db.connections.owner.filter(userId)].sort((x, y) => y.at - x.at);
  const out = [];
  for (const c of conns) {
    const other = publicProfile(ctx, tx.db.users.id.find(c.other));
    if (!other) continue;
    const convo = latestConversation(tx, userId, c.other);
    out.push({ ...other, connectedAt: c.at, lastSummary: convo?.summary });
  }
  return out;
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
  return {
    person: other,
    connectedAt: connection?.at,
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
 * or most recently talked with or saved; heads ups and intros don't count.
 */
export function current({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  let latest: { at: number; other?: string } | undefined;
  for (const a of tx.db.activity.owner.filter(userId)) {
    if (a.kind !== "talked" && a.kind !== "saved") continue;
    if (!latest || a.at >= latest.at) latest = a;
  }
  return latest?.other ?? null;
}
