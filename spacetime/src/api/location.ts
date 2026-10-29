import { coarse, metersBetween } from "../lib/privacy";
import { nowMs } from "../lib/db";
import type { Tx } from "../schema";
import { num, str, type Ctx } from "./context";

/**
 * Approximate location, used only to decide whether a heads up makes sense
 * ("they are somewhere in this hall"), never shown to anyone. The app sends a
 * reduced accuracy fix (about 100 to 1000 m) every few minutes while it is
 * open; the server rounds it to a 110 m grid and forgets it after 15 minutes.
 */

export const LOCATION_TTL_MS = 15 * 60_000;
/** Heads ups only go out when both people are about this close. */
export const HEADSUP_RADIUS_M = 300;

/** location:report { userId, lat, lng, accuracy? } */
export function report({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  if (!tx.db.users.id.find(userId)) return null;
  const lat = num(args, "lat");
  const lng = num(args, "lng");
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const accuracy = typeof args.accuracy === "number" && Number.isFinite(args.accuracy) ? Math.max(100, args.accuracy) : 1000;
  const row = { userId, lat: coarse(lat), lng: coarse(lng), accuracy: Math.round(accuracy), at: nowMs(tx) };
  if (tx.db.coarseLocations.userId.find(userId)) tx.db.coarseLocations.userId.update(row);
  else tx.db.coarseLocations.insert(row);
  return null;
}

/** location:clear { userId } (sharing turned off in Settings, or sign out). */
export function clear({ tx }: Ctx, args: Record<string, unknown>) {
  tx.db.coarseLocations.userId.delete(str(args, "userId"));
  return null;
}

/** A fresh coarse location, or null when missing or older than 15 minutes. */
export function freshLocation(tx: Tx, userId: string) {
  const row = tx.db.coarseLocations.userId.find(userId);
  if (!row || nowMs(tx) - row.at > LOCATION_TTL_MS) return null;
  return row;
}

/** Both phones reported recently and are within about 300 m of each other. */
export function roughlyTogether(tx: Tx, a: string, b: string) {
  const la = freshLocation(tx, a);
  const lb = freshLocation(tx, b);
  if (!la || !lb) return false;
  return metersBetween(la, lb) <= HEADSUP_RADIUS_M;
}

/** Every minute: drop expired rows so nothing lingers. */
export function purgeExpired(tx: Tx) {
  const now = nowMs(tx);
  for (const row of [...tx.db.coarseLocations.iter()]) {
    if (now - row.at > LOCATION_TTL_MS) tx.db.coarseLocations.userId.delete(row.userId);
  }
}
