import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { openConversation } from "./conversations";
import { canonicalPair } from "./lib/pairs";
import { ACTIVE_WINDOW_MS, TALK_AFTER_MS, TALK_DISTANCE_M } from "./lib/constants";

/**
 * Nearby Interaction plumbing.
 *
 * For each peer at the event, a phone creates one NISession, publishes that
 * session's discovery token for that peer (uploadToken), and starts ranging
 * once the peer's token for it shows up in `peers`. Distances come back
 * through reportDistance.
 */

/** Everyone else at the event, with the token they published for me (if any). */
export const peers = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    const users = await ctx.db.query("users").collect();
    const out = [];
    for (const u of users) {
      if (u._id === userId || (u.lastSeenAt ?? 0) < cutoff) continue;
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
    if (closeSince !== undefined && now - closeSince >= TALK_AFTER_MS) {
      await openConversation(ctx, pair.a, pair.b);
    }
  },
});
