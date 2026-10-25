import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { openConversation } from "./conversations";
import { canonicalPair } from "./lib/pairs";
import { MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { loadRubric } from "./lib/rubric";
import { NEARBY_ACTIVE_MS, PROXIMITY_FRESH_MS, TALK_AFTER_MS, TALK_DISTANCE_M } from "./lib/constants";
import { isDemoPhone } from "./lib/phone";

/**
 * Nearby Interaction plumbing.
 *
 * For each peer at the event, a phone creates one NISession, publishes that
 * session's discovery token for that peer (uploadToken), and starts ranging
 * once the peer's token for it shows up in `peers`. Distances come back
 * through reportDistance.
 */

/**
 * Phones to range with: people whose app is open right now (heartbeat within
 * NEARBY_ACTIVE_MS), with the token they published for me (if any). Seeded
 * demo people have no phone, so they're skipped: every peer costs a UWB
 * session, and iOS only runs a handful at once.
 */
export const peers = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const cutoff = Date.now() - NEARBY_ACTIVE_MS;
    const users = await ctx.db.query("users").collect();
    const out = [];
    for (const u of users) {
      if (u._id === userId || (u.lastSeenAt ?? 0) < cutoff || isDemoPhone(u.phone)) continue;
      const theirs = await ctx.db
        .query("nearbyTokens")
        .withIndex("by_owner_peer", (q) => q.eq("userId", u._id).eq("peerId", userId))
        .unique();
      out.push({ userId: u._id, name: u.name ?? "", tokenForMe: theirs?.token });
    }
    return out;
  },
});

export const uploadToken = mutation({
  args: { userId: v.id("users"), peerId: v.id("users"), token: v.string() },
  handler: async (ctx, { userId, peerId, token }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("nearbyTokens")
      .withIndex("by_owner_peer", (q) => q.eq("userId", userId).eq("peerId", peerId))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { token, updatedAt: now });
    else await ctx.db.insert("nearbyTokens", { userId, peerId, token, updatedAt: now });
  },
});

/** Called by the phone about once per second per peer. */
export const reportDistance = mutation({
  args: { userId: v.id("users"), peerId: v.id("users"), meters: v.number() },
  handler: async (ctx, { userId, peerId, meters }) => {
    const now = Date.now();
    const pair = canonicalPair(userId, peerId);
    const row = await ctx.db
      .query("proximity")
      .withIndex("by_pair", (q) => q.eq("a", pair.a).eq("b", pair.b))
      .unique();

    const close = meters <= TALK_DISTANCE_M;
    const closeSince = close ? (row?.closeSince ?? now) : undefined;
    if (row) {
      await ctx.db.patch(row._id, { meters, at: now, closeSince, minMeters: Math.min(row.minMeters, meters) });
    } else {
      await ctx.db.insert("proximity", { ...pair, meters, at: now, closeSince, minMeters: meters });
    }

    // Close long enough: open a conversation if none is open for this pair.
    // Only matched pairs: strangers standing in line together are not a conversation.
    if (closeSince !== undefined && now - closeSince >= TALK_AFTER_MS && (await isMatch(ctx, userId, peerId))) {
      await openConversation(ctx, pair.a, pair.b);
    }
  },
});

/** Either side's score clears the rubric threshold (same rule the badge uses). */
async function isMatch(ctx: MutationCtx, x: Id<"users">, y: Id<"users">) {
  const rubric = await loadRubric(ctx);
  const [xy, yx] = await Promise.all([
    ctx.db.query("matches").withIndex("by_pair", (q) => q.eq("viewer", x).eq("other", y)).unique(),
    ctx.db.query("matches").withIndex("by_pair", (q) => q.eq("viewer", y).eq("other", x)).unique(),
  ]);
  return Math.max(xy?.score ?? 0, yx?.score ?? 0) >= rubric.threshold;
}

/**
 * What the server sees for my nearby phones: latest distance, how fresh it is,
 * whether both sides published tokens, and the match score each way. Powers the
 * Nearby debug panel in Settings.
 */
export const debug = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const now = Date.now();
    const rows = [
      ...(await ctx.db.query("proximity").withIndex("by_a", (q) => q.eq("a", userId)).collect()),
      ...(await ctx.db.query("proximity").withIndex("by_b", (q) => q.eq("b", userId)).collect()),
    ];
    const out = [];
    for (const r of rows) {
      const peerId = r.a === userId ? r.b : r.a;
      const peer = await ctx.db.get(peerId);
      const [mine, theirs, myToken, theirToken] = await Promise.all([
        ctx.db.query("matches").withIndex("by_pair", (q) => q.eq("viewer", userId).eq("other", peerId)).unique(),
        ctx.db.query("matches").withIndex("by_pair", (q) => q.eq("viewer", peerId).eq("other", userId)).unique(),
        ctx.db.query("nearbyTokens").withIndex("by_owner_peer", (q) => q.eq("userId", userId).eq("peerId", peerId)).unique(),
        ctx.db.query("nearbyTokens").withIndex("by_owner_peer", (q) => q.eq("userId", peerId).eq("peerId", userId)).unique(),
      ]);
      out.push({
        peerId,
        name: peer?.name ?? "",
        meters: r.meters,
        ageSeconds: Math.round((now - r.at) / 1000),
        fresh: now - r.at < PROXIMITY_FRESH_MS,
        score: Math.max(mine?.score ?? 0, theirs?.score ?? 0),
        tokensBothWays: Boolean(myToken && theirToken),
      });
    }
    return out.sort((x, y) => x.ageSeconds - y.ageSeconds);
  },
});
