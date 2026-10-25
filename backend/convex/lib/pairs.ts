import { Id } from "../_generated/dataModel";
import { MATCH_COLORS } from "./constants";

/** Order two user ids so symmetric facts are stored once per pair. */
export function canonicalPair(x: Id<"users">, y: Id<"users">) {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

/** The other person in a canonical pair. */
export function otherOf(pair: { a: Id<"users">; b: Id<"users"> }, me: Id<"users">) {
  return pair.a === me ? pair.b : pair.a;
}

/** Same color on both badges: derived from the pair, not the viewer. */
export function pairColor(x: Id<"users">, y: Id<"users">) {
  const { a, b } = canonicalPair(x, y);
  let hash = 0;
  for (const ch of a + b) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return MATCH_COLORS[hash % MATCH_COLORS.length];
}
