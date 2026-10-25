import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { openConversation } from "./conversations";
import { canonicalPair } from "./lib/pairs";
import { ACTIVE_WINDOW_MS, TALK_AFTER_MS, TALK_DISTANCE_M } from "./lib/constants";

/**
 * Nearby Interaction plumbing. Each phone uploads its discovery token, reads
 * everyone else's, runs a UWB session per peer, and reports distances back.
 */

export const uploadToken = mutation({
  args: { userId: v.id("users"), token: v.string() },
  handler: async (ctx, { userId, token }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("nearbyTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { token, updatedAt: now });
    else await ctx.db.insert("nearbyTokens", { userId, token, updatedAt: now });
    await ctx.db.patch(userId, { lastSeenAt: now });
  },
});

/** Tokens of everyone else currently at the event. */
export const peers = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const tokens = await ctx.db.query("nearbyTokens").collect();
    const out = [];
    for (const t of tokens) {
      if (t.userId === userId) continue;
      const u = await ctx.db.get(t.userId);
      if (!u || (u.lastSeenAt ?? 0) < Date.now() - ACTIVE_WINDOW_MS) continue;
      out.push({ userId: t.userId, token: t.token });
    }
    return out;
  },
});

/** Called by the phone a few times per second per peer (throttle on device). */
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
      await ctx.db.patch(row._id, {
        meters,
        at: now,
        closeSince,
        minMeters: Math.min(row.minMeters, meters),
      });
    } else {
      await ctx.db.insert("proximity", { ...pair, meters, at: now, closeSince, minMeters: meters });
    }
    await ctx.db.patch(userId, { lastSeenAt: now });

    // Close long enough: open a conversation if none is open for this pair.
    if (closeSince !== undefined && now - closeSince >= TALK_AFTER_MS) {
      await openConversation(ctx, pair.a, pair.b);
    }
  },
});
