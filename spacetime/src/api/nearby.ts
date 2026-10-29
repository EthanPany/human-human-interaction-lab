import {
  BLE_FRESH_MS,
  BLE_HOLD_RSSI,
  BLE_ID_GRACE_MS,
  BLE_ID_ROTATE_MS,
  BLE_IN_AREA_RSSI,
  BLE_MIN_ESTIMATE_M,
  BLE_PROXIMITY_MAX_M,
  BLE_TOGETHER_RSSI,
  bleEstimateM,
  closenessAt,
  NEARBY_ACTIVE_MS,
  PROXIMITY_FRESH_MS,
  STANDARD_RANGE_M,
  TALK_DISTANCE_M,
  TALK_EXIT_DISTANCE_M,
  UWB_FRESH_MS,
  UWB_LOST_FOR_ESTIMATE_MS,
  UWB_MERGE_MS,
} from "../lib/constants";
import { avatarOf } from "../lib/avatar";
import { canonicalPair, directedKey, isMatchPair, matchOf, newId, nowMs, pairColor, pairKey } from "../lib/db";
import { isDemoPhone } from "../lib/phone";
import type { Tx } from "../schema";
import { leave, openEncounterOf, reconcile, togetherNow } from "./groups";
import { markMet } from "./people";
import { ArgError, num, str, type Ctx } from "./context";

/** Port of backend/convex/nearby.ts (Nearby Interaction tokens and distances), plus the Bluetooth assist. */

// Merging both phones' readings ----------------------------------------------------

/** When either phone last had a UWB reading of the other (0: never). */
export function latestUwbAt(tx: Tx, x: string, y: string) {
  const r1 = tx.db.pairReadings.id.find(directedKey(x, y));
  const r2 = tx.db.pairReadings.id.find(directedKey(y, x));
  return Math.max(r1?.at ?? 0, r2?.at ?? 0);
}

/** The strongest fresh Bluetooth signal either badge heard from the other, if they are in the area. */
export function bleRssiOf(tx: Tx, x: string, y: string, now: number) {
  let best: number | undefined;
  for (const id of [directedKey(x, y), directedKey(y, x)]) {
    const s = tx.db.bleSightings.id.find(id);
    if (!s || now - s.at > BLE_FRESH_MS || s.rssi < BLE_IN_AREA_RSSI) continue;
    if (best === undefined || s.rssi > best) best = s.rssi;
  }
  return best;
}

/** Where a pair's distance in the proximity row came from: UWB, or a Bluetooth estimate. */
export function distanceSourceOf(tx: Tx, row: { a: string; b: string; at: number }): "uwb" | "ble" {
  return latestUwbAt(tx, row.a, row.b) >= row.at - UWB_FRESH_MS ? "uwb" : "ble";
}

/**
 * The pair's distance from both phones: UWB first (the smaller of two recent
 * readings, else the freshest), then a coarse Bluetooth estimate. Bluetooth
 * says "together" only when UWB had nothing for a while and the signal is
 * very strong; once together, a strong signal holds it while UWB is blind.
 */
function mergedDistance(tx: Tx, x: string, y: string, now: number, wasClose: boolean, heldMeters: number | undefined) {
  const readings = [tx.db.pairReadings.id.find(directedKey(x, y)), tx.db.pairReadings.id.find(directedKey(y, x))]
    .filter((r): r is NonNullable<typeof r> => r != null && now - r.at <= UWB_FRESH_MS);
  if (readings.length > 0) {
    const recent = readings.filter((r) => now - r.at <= UWB_MERGE_MS);
    if (recent.length === 2) return { meters: Math.min(recent[0].meters, recent[1].meters), source: "uwb" as const };
    const newest = readings.reduce((p, q) => (q.at > p.at ? q : p));
    return { meters: newest.meters, source: "uwb" as const };
  }
  const rssi = bleRssiOf(tx, x, y, now);
  if (rssi === undefined) return undefined;
  const estimate = bleEstimateM(rssi);
  const uwbLostFor = now - latestUwbAt(tx, x, y);
  if (rssi >= BLE_TOGETHER_RSSI && uwbLostFor >= UWB_LOST_FOR_ESTIMATE_MS) {
    return { meters: Math.min(estimate, TALK_DISTANCE_M * 0.9), source: "ble" as const };
  }
  if (wasClose && heldMeters !== undefined && rssi >= BLE_HOLD_RSSI) return { meters: heldMeters, source: "ble" as const };
  if (estimate > BLE_PROXIMITY_MAX_M) return undefined;
  return { meters: Math.max(BLE_MIN_ESTIMATE_M, estimate), source: "ble" as const };
}

/**
 * Recompute the pair's proximity row from both phones' readings, then bring
 * encounters in line (groups.ts): together for a moment starts or continues
 * one, a third person joining makes it a group, apart leaves it.
 */
function updatePair(tx: Tx, x: string, y: string, now: number) {
  const pair = canonicalPair(x, y);
  const id = pairKey(x, y);
  const row = tx.db.proximity.id.find(id);
  // Close within talking distance; once close, stay close until clearly apart
  // (readings jitter around the threshold).
  // (A row nobody updated for a while doesn't count: they parted unseen.)
  const wasClose = row?.closeSince !== undefined && now - row.at < PROXIMITY_FRESH_MS;
  const merged = mergedDistance(tx, x, y, now, wasClose, row?.meters);
  if (!merged) return;
  const meters = merged.meters;
  const close = meters <= TALK_DISTANCE_M || (wasClose && meters <= TALK_EXIT_DISTANCE_M);
  const closeSince = close ? (wasClose ? row?.closeSince ?? now : now) : undefined;
  if (row) {
    tx.db.proximity.id.update({ ...row, meters, at: now, closeSince, minMeters: Math.min(row.minMeters, meters) });
  } else {
    tx.db.proximity.insert({ id, ...pair, meters, at: now, closeSince, minMeters: meters });
  }
  // Just came close: a matched pair met. Each shows up in the other's People
  // list (others join it once their encounter is kept).
  if (closeSince !== undefined && !wasClose && isMatchPair(tx, x, y)) markMet(tx, x, y);
  // Together for TALK_AFTER_MS starts (or continues, or grows) an encounter,
  // match or not; apart from everyone in it, a person leaves it.
  if (closeSince !== undefined || wasClose || openEncounterOf(tx, x) || openEncounterOf(tx, y)) reconcile(tx, [x, y], now);
}

// Bluetooth ids ---------------------------------------------------------------------

/** The Bluetooth id a badge advertises right now (undefined: no Bluetooth on that phone). */
export function bleIdOf(tx: Tx, userId: string, now: number) {
  let best: { id: string; issuedAt: number; expiresAt: number } | undefined;
  for (const r of tx.db.bleIds.userId.filter(userId)) {
    if (r.expiresAt <= now) continue;
    if (!best || r.issuedAt > best.issuedAt) best = r;
  }
  return best;
}

/**
 * nearby:bleId {userId} -> {bleId, expiresAt}: the short id this badge
 * advertises over Bluetooth. It changes every 15 minutes (ask again after
 * expiresAt); the previous one still resolves for 2 minutes.
 */
export function bleId({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  if (!tx.db.users.id.find(userId)) return null;
  const now = nowMs(tx);
  for (const r of [...tx.db.bleIds.userId.filter(userId)]) {
    if (now > r.expiresAt + BLE_ID_GRACE_MS) tx.db.bleIds.id.delete(r.id);
  }
  const current = bleIdOf(tx, userId, now);
  if (current && current.expiresAt - now > 60_000) return { bleId: current.id, expiresAt: current.expiresAt };
  let id = newId(tx).slice(0, 6).toUpperCase();
  while (tx.db.bleIds.id.find(id)) id = newId(tx).slice(0, 6).toUpperCase();
  const expiresAt = now + BLE_ID_ROTATE_MS;
  tx.db.bleIds.insert({ id, userId, issuedAt: now, expiresAt });
  return { bleId: id, expiresAt };
}

/**
 * nearby:reportBle {userId, sightings: [{bleId, rssi}]}: the badges this
 * phone hears over Bluetooth and how strongly (smoothed dBm), every couple of
 * seconds while the badge is worn.
 */
export function reportBle({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  if (!Array.isArray(args.sightings)) throw new ArgError("Argument sightings must be an array");
  if (!tx.db.ranging.userId.find(userId)) return null;
  const now = nowMs(tx);
  for (const raw of args.sightings.slice(0, 24) as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as { bleId?: unknown; rssi?: unknown };
    if (typeof s.bleId !== "string" || typeof s.rssi !== "number" || !Number.isFinite(s.rssi)) continue;
    if (s.rssi >= 0 || s.rssi < -127) continue; // 127 means "not available"
    const owner = tx.db.bleIds.id.find(s.bleId.toUpperCase());
    if (!owner || owner.userId === userId || now > owner.expiresAt + BLE_ID_GRACE_MS) continue;
    const peer = owner.userId;
    if (!tx.db.ranging.userId.find(peer)) continue;
    const id = directedKey(userId, peer);
    const row = { id, observer: userId, seen: peer, rssi: s.rssi, at: now };
    if (tx.db.bleSightings.id.find(id)) tx.db.bleSightings.id.update(row);
    else tx.db.bleSightings.insert(row);
    updatePair(tx, userId, peer, now);
  }
  return null;
}

// Peers, tokens, distances ---------------------------------------------------------

/**
 * Everyone else wearing their badge right now, with the token they published
 * for me (if any), most important first. A phone can only run a few UWB
 * sessions at once, so it ranges with the first ones: the person I'm in an
 * encounter with, then matches in the area (best first), then others in the
 * area (closest first), then everyone Bluetooth knows nothing about, and last
 * those Bluetooth says are not around (both badges advertise and neither
 * hears the other). Recency breaks ties in 10 s steps so the order doesn't
 * reshuffle with every reading (each reshuffle costs a UWB session).
 *
 * Each peer also carries what the server knows: the merged distance of the
 * pair (`meters`, `source` uwb or ble, `ageMs`), whether they are in the area,
 * the Bluetooth id they advertise (`bleId`), and for matches the pair color
 * and their avatar color (the badge's edge glows).
 */
export function peers({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  if (!tx.db.ranging.userId.find(userId)) return [];
  const now = nowMs(tx);
  // Only phones open right now: every peer costs a UWB session on the phone.
  const cutoff = now - NEARBY_ACTIVE_MS;
  const iHaveBle = bleIdOf(tx, userId, now) !== undefined;
  const out = [];
  for (const u of tx.db.users.iter()) {
    if (u.id === userId || (u.lastSeenAt ?? 0) < cutoff || isDemoPhone(u.phone)) continue;
    if (!tx.db.ranging.userId.find(u.id)) continue; // only badges worn full screen
    const theirs = tx.db.nearbyTokens.id.find(directedKey(u.id, userId));
    const isMatch = isMatchPair(tx, userId, u.id);
    const score = Math.max(matchOf(tx, userId, u.id)?.score ?? 0, matchOf(tx, u.id, userId)?.score ?? 0);
    const inEncounter = togetherNow(tx, userId, u.id);
    const row = tx.db.proximity.id.find(pairKey(userId, u.id));
    const fresh = row != null && now - row.at < PROXIMITY_FRESH_MS;
    const rssi = bleRssiOf(tx, userId, u.id, now);
    const theirBle = bleIdOf(tx, u.id, now);
    const inArea = fresh || rssi !== undefined;
    // Both advertise and listen, and nobody hears anybody: they are not around.
    const away = !inArea && iHaveBle && theirBle !== undefined;
    const near = fresh ? closenessAt(row.meters, STANDARD_RANGE_M) : 0;
    let rank: number;
    if (inEncounter) rank = 10;
    else if (isMatch) rank = (inArea ? 6 : away ? 1.5 : 3) + Math.min(score, 0.99);
    else rank = inArea ? 4 + 0.9 * near : away ? 1 : 2;
    const recency = Math.floor(Math.max(row?.at ?? 0, u.lastSeenAt ?? 0) / 10_000);
    const avatar = isMatch ? avatarOf({ _id: u.id, avatarShape: u.avatarShape, avatarColor: u.avatarColor }) : undefined;
    out.push({
      userId: u.id,
      name: u.name ?? "",
      tokenForMe: theirs?.token,
      isMatch,
      priority: rank,
      inArea,
      bleId: theirBle?.id,
      meters: fresh ? row.meters : undefined,
      source: fresh ? distanceSourceOf(tx, row) : undefined,
      ageMs: fresh ? now - row.at : undefined,
      color: isMatch ? pairColor(userId, u.id) : undefined,
      avatarColor: avatar?.color,
      rank,
      recency,
    });
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

/** This phone's own UWB reading of a peer, a few times a second per peer. */
export function reportDistance({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const peerId = str(args, "peerId");
  const meters = num(args, "meters");
  // This pair's sessions run extended UWB (about 50 m); older apps don't say.
  const extended = args.extended === true;
  const now = nowMs(tx);
  // A late reading from a phone that already took its badge off doesn't count.
  if (!tx.db.ranging.userId.find(userId) || !tx.db.ranging.userId.find(peerId)) return null;
  const id = pairKey(userId, peerId);

  const readingId = directedKey(userId, peerId);
  const reading = { id: readingId, userId, peerId, meters, at: now };
  if (tx.db.pairReadings.id.find(readingId)) tx.db.pairReadings.id.update(reading);
  else tx.db.pairReadings.insert(reading);

  const ext = tx.db.extendedPairs.id.find(id);
  if (extended && !ext) tx.db.extendedPairs.insert({ id, at: now });
  else if (extended && ext) tx.db.extendedPairs.id.update({ id, at: now });
  // No extended reading from either phone for 10 s: back to standard range
  else if (!extended && ext && now - ext.at > 10_000) tx.db.extendedPairs.id.delete(id);

  updatePair(tx, userId, peerId, now);
  return null;
}

/**
 * The badge went full screen (on) or was taken off, minimized or closed (off).
 * Off clears this person's distances, tokens and Bluetooth ids at once, so the
 * other phone's badge lets go immediately.
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
  // Badge off: out of their encounter at once (the rest of a group goes on)
  const open = openEncounterOf(tx, userId);
  if (open) leave(tx, open, userId, now);
  for (const r of [...tx.db.proximity.a.filter(userId), ...tx.db.proximity.b.filter(userId)]) {
    tx.db.proximity.id.delete(r.id);
    tx.db.extendedPairs.id.delete(r.id);
  }
  for (const t of [...tx.db.nearbyTokens.userId.filter(userId), ...tx.db.nearbyTokens.peerId.filter(userId)]) {
    tx.db.nearbyTokens.id.delete(t.id);
  }
  for (const r of [...tx.db.pairReadings.userId.filter(userId), ...tx.db.pairReadings.peerId.filter(userId)]) {
    tx.db.pairReadings.id.delete(r.id);
  }
  for (const s of [...tx.db.bleSightings.observer.filter(userId), ...tx.db.bleSightings.seen.filter(userId)]) {
    tx.db.bleSightings.id.delete(s.id);
  }
  for (const b of [...tx.db.bleIds.userId.filter(userId)]) tx.db.bleIds.id.delete(b.id);
  return null;
}
