import { NEARBY_ACTIVE_MS, PROXIMITY_FRESH_MS, TALK_AFTER_MS, TALK_DISTANCE_M, TALK_EXIT_DISTANCE_M } from "../lib/constants";
import { canonicalPair, directedKey, isMatchPair, matchOf, nowMs, openConversationOf, pairKey } from "../lib/db";
import { isDemoPhone } from "../lib/phone";
import { openConversation } from "./conversations";
import { markMet } from "./people";
import { num, str, type Ctx } from "./context";

/** Port of backend/convex/nearby.ts (Nearby Interaction tokens and distances). */

/**
 * Everyone else wearing their badge right now, with the token they published
 * for me (if any), most important first. A phone can only run a few UWB
 * sessions at once, so it ranges with the first ones: the person I'm in an
 * encounter with, then matches (best first), then everyone else, most
 * recently near first (anyone within 1 m starts an encounter, match or not).
 */
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
    const isMatch = isMatchPair(tx, userId, u.id);
    const score = Math.max(matchOf(tx, userId, u.id)?.score ?? 0, matchOf(tx, u.id, userId)?.score ?? 0);
    const inEncounter = openConversationOf(tx, userId, u.id) !== null;
    const lastNear = tx.db.proximity.id.find(pairKey(userId, u.id))?.at ?? 0;
    const rank = inEncounter ? 3 : isMatch ? 2 + Math.min(score, 0.99) : 1;
    out.push({ userId: u.id, name: u.name ?? "", tokenForMe: theirs?.token, isMatch, rank, recency: Math.max(lastNear, u.lastSeenAt ?? 0) });
  }
  out.sort((x, y) => y.rank - x.rank || y.recency - x.recency);
  return out.map(({ rank, recency, ...p }) => p);
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
  // This pair's sessions run extended UWB (about 50 m); older apps don't say.
  const extended = args.extended === true;
  const now = nowMs(tx);
  // A late reading from a phone that already took its badge off doesn't count.
  if (!tx.db.ranging.userId.find(userId) || !tx.db.ranging.userId.find(peerId)) return null;
  const pair = canonicalPair(userId, peerId);
  const id = pairKey(userId, peerId);
  const row = tx.db.proximity.id.find(id);

  // Close within talking distance; once close, stay close until clearly apart
  // (both phones report here and readings jitter around the threshold).
  // (A row nobody updated for a while doesn't count: they parted unseen.)
  const wasClose = row?.closeSince !== undefined && now - row.at < PROXIMITY_FRESH_MS;
  const close = meters <= TALK_DISTANCE_M || (wasClose && meters <= TALK_EXIT_DISTANCE_M);
  const closeSince = close ? (row?.closeSince ?? now) : undefined;
  if (row) {
    tx.db.proximity.id.update({ ...row, meters, at: now, closeSince, minMeters: Math.min(row.minMeters, meters) });
  } else {
    tx.db.proximity.insert({ id, ...pair, meters, at: now, closeSince, minMeters: meters });
  }

  const ext = tx.db.extendedPairs.id.find(id);
  if (extended && !ext) tx.db.extendedPairs.insert({ id, at: now });
  else if (extended && ext) tx.db.extendedPairs.id.update({ id, at: now });
  // No extended reading from either phone for 10 s: back to standard range
  else if (!extended && ext && now - ext.at > 10_000) tx.db.extendedPairs.id.delete(id);

  if (closeSince === undefined) return null;

  const matched = isMatchPair(tx, userId, peerId);
  // Just came close: a matched pair met. Each shows up in the other's People
  // list (others join it once their encounter is kept).
  if (!wasClose && matched) markMet(tx, userId, peerId);
  // Together long enough: an encounter starts (or continues), match or not.
  if (now - closeSince >= TALK_AFTER_MS) openConversation(tx, pair.a, pair.b, matched);
  return null;
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
  for (const r of [...tx.db.proximity.a.filter(userId), ...tx.db.proximity.b.filter(userId)]) {
    tx.db.proximity.id.delete(r.id);
    tx.db.extendedPairs.id.delete(r.id);
  }
  for (const t of [...tx.db.nearbyTokens.userId.filter(userId), ...tx.db.nearbyTokens.peerId.filter(userId)]) {
    tx.db.nearbyTokens.id.delete(t.id);
  }
  return null;
}
