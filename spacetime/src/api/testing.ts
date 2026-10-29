import { directedKey, pairKey } from "../lib/db";
import { ArgError, type Ctx } from "./context";
import { deleteConversation } from "./conversations";

/** Port of backend/convex/testing.ts. Only these fictional numbers can be reset (scripts/e2e.mjs). */
const TEST_PHONES = ["+14155550190", "+14155550191"];

/** Forget everything between the two e2e test users so the test can rerun. */
export function resetTestPair({ tx }: Ctx, args: Record<string, unknown>) {
  const phones = args.phones;
  if (!Array.isArray(phones) || phones.length !== 2 || !phones.every((p) => TEST_PHONES.includes(p))) {
    throw new ArgError("Test numbers only");
  }
  const ids = phones.map((p) => tx.db.users.phone.find(p)?.id).filter((x): x is string => Boolean(x));
  if (ids.length !== 2) return null;
  const [x, y] = ids;
  for (const c of [...tx.db.conversations.pair.filter(pairKey(x, y))]) deleteConversation(tx, c.id);
  tx.db.extendedPairs.id.delete(pairKey(x, y));
  for (const id of ids) tx.db.userPrefs.userId.delete(id);
  tx.db.proximity.id.delete(pairKey(x, y));
  tx.db.pairReadings.id.delete(directedKey(x, y));
  tx.db.pairReadings.id.delete(directedKey(y, x));
  tx.db.bleSightings.id.delete(directedKey(x, y));
  tx.db.bleSightings.id.delete(directedKey(y, x));
  tx.db.meetings.id.delete(pairKey(x, y));
  for (const [owner, other] of [[x, y], [y, x]]) {
    tx.db.connections.id.delete(directedKey(owner, other));
    for (const a of [...tx.db.activity.owner.filter(owner)]) if (a.other === other) tx.db.activity.id.delete(a.id);
  }
  return null;
}
