import { NEARBY_ACTIVE_MS, TALK_AFTER_MS, TALK_DISTANCE_M, TALK_EXIT_DISTANCE_M } from "../lib/constants";
import { canonicalPair, directedKey, loadRubric, matchOf, nowMs, pairKey } from "../lib/db";
import { isDemoPhone } from "../lib/phone";
import type { Tx } from "../schema";
import { openConversation } from "./conversations";
import { markMet } from "./people";
import { num, str, type Ctx } from "./context";

/** Port of backend/convex/nearby.ts (Nearby Interaction tokens and distances). */

/** Everyone else at the event, with the token they published for me (if any). */
export function peers({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  if (!tx.db.ranging.userId.find(userId)) return [];
  // Only phones open right now: every peer costs a UWB session on the phone.
  const cutoff = nowMs(tx) - NEARBY_ACTIVE_MS;
  const out = [];
  for (const u of tx.db.users.iter()) {
    if (u.id === userId || (u.lastSeenAt ?? 0) < cutoff || isDemoPhone(u.phone)) continue;
    if (!tx.db.ranging.userId.find(u.id)) continue; // only badges worn full screen
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
  // A late reading from a phone that already took its badge off doesn't count.
  if (!tx.db.ranging.userId.find(userId) || !tx.db.ranging.userId.find(peerId)) return null;
  const pair = canonicalPair(userId, peerId);
  const id = pairKey(userId, peerId);
  const row = tx.db.proximity.id.find(id);

  // Close within talking distance; once close, stay close until clearly apart
  // (both phones report here and readings jitter around the threshold).
  const wasClose = row?.closeSince !== undefined;
  const close = meters <= TALK_DISTANCE_M || (wasClose && meters <= TALK_EXIT_DISTANCE_M);
  const closeSince = close ? (row?.closeSince ?? now) : undefined;
  if (row) {
    tx.db.proximity.id.update({ ...row, meters, at: now, closeSince, minMeters: Math.min(row.minMeters, meters) });
  } else {
    tx.db.proximity.insert({ id, ...pair, meters, at: now, closeSince, minMeters: meters });
  }

  if (closeSince === undefined) return null;

  // Only matched pairs: strangers standing in line together have not "met".
  if (!isMatch(tx, userId, peerId)) return null;
  // Just came close: they met. Each shows up in the other's People list.
  if (!wasClose) markMet(tx, userId, peerId);
  // Close long enough: open a conversation if none is open for this pair.
  if (now - closeSince >= TALK_AFTER_MS) openConversation(tx, pair.a, pair.b);
  return null;
}

/** Either side's score clears the rubric threshold (same rule the badge uses). */
function isMatch(tx: Tx, x: string, y: string) {
  const rubric = loadRubric(tx);
  return Math.max(matchOf(tx, x, y)?.score ?? 0, matchOf(tx, y, x)?.score ?? 0) >= rubric.threshold;
}

/**
 * The badge went full screen (on) or was taken off, minimized or closed (off).
 * Off clears this person's distances and tokens at once, so the other phone's
 * badge lets go immediately.
 */
export function setRanging({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const on = args.on === true;
  const now = nowMs(tx);
  const u = tx.db.users.id.find(userId);
  if (u) tx.db.users.id.update({ ...u, lastSeenAt: now });
  const row = tx.db.ranging.userId.find(userId);
  if (on) {
    if (!row) tx.db.ranging.insert({ userId, since: now });
    return null;
  }
  if (row) tx.db.ranging.userId.delete(userId);
  for (const r of [...tx.db.proximity.a.filter(userId), ...tx.db.proximity.b.filter(userId)]) tx.db.proximity.id.delete(r.id);
  for (const t of [...tx.db.nearbyTokens.userId.filter(userId), ...tx.db.nearbyTokens.peerId.filter(userId)]) {
    tx.db.nearbyTokens.id.delete(t.id);
  }
  return null;
}
