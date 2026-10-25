import { ACTIVE_WINDOW_MS, TALK_AFTER_MS, TALK_DISTANCE_M } from "../lib/constants";
import { canonicalPair, directedKey, loadRubric, matchOf, nowMs, pairKey } from "../lib/db";
import type { Tx } from "../schema";
import { openConversation } from "./conversations";
import { num, str, type Ctx } from "./context";

/** Port of backend/convex/nearby.ts (Nearby Interaction tokens and distances). */

/** Everyone else at the event, with the token they published for me (if any). */
export function peers({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const cutoff = nowMs(tx) - ACTIVE_WINDOW_MS;
  const out = [];
  for (const u of tx.db.users.iter()) {
    if (u.id === userId || (u.lastSeenAt ?? 0) < cutoff) continue;
    const theirs = tx.db.nearbyTokens.id.find(directedKey(u.id, userId));
    out.push({ userId: u.id, name: u.name ?? "", tokenForMe: theirs?.token });
  }
  return out;
}

export function uploadToken({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const peerId = str(args, "peerId");
  const token = str(args, "token");
  const id = directedKey(userId, peerId);
  const row = { id, userId, peerId, token, updatedAt: nowMs(tx) };
  if (tx.db.nearbyTokens.id.find(id)) tx.db.nearbyTokens.id.update(row);
  else tx.db.nearbyTokens.insert(row);
  return null;
}

/** Called by the phone about once per second per peer. */
export function reportDistance({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const peerId = str(args, "peerId");
  const meters = num(args, "meters");
  const now = nowMs(tx);
  const pair = canonicalPair(userId, peerId);
  const id = pairKey(userId, peerId);
  const row = tx.db.proximity.id.find(id);

  const close = meters <= TALK_DISTANCE_M;
  const closeSince = close ? (row?.closeSince ?? now) : undefined;
  if (row) {
    tx.db.proximity.id.update({ ...row, meters, at: now, closeSince, minMeters: Math.min(row.minMeters, meters) });
  } else {
    tx.db.proximity.insert({ id, ...pair, meters, at: now, closeSince, minMeters: meters });
  }

  // Close long enough: open a conversation if none is open for this pair.
  // Only matched pairs: strangers standing in line together are not a conversation.
  if (closeSince !== undefined && now - closeSince >= TALK_AFTER_MS && isMatch(tx, userId, peerId)) {
    openConversation(tx, pair.a, pair.b);
  }
  return null;
}

/** Either side's score clears the rubric threshold (same rule the badge uses). */
function isMatch(tx: Tx, x: string, y: string) {
  const rubric = loadRubric(tx);
  return Math.max(matchOf(tx, x, y)?.score ?? 0, matchOf(tx, y, x)?.score ?? 0) >= rubric.threshold;
}
