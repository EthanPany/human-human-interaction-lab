import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { openConversation } from "./conversations";
import { canonicalPair } from "./lib/pairs";
import { MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { loadRubric } from "./lib/rubric";
import { NEARBY_ACTIVE_MS, PROXIMITY_FRESH_MS, TALK_AFTER_MS, TALK_DISTANCE_M, TALK_EXIT_DISTANCE_M } from "./lib/constants";
import { markMet } from "./people";
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
    const me = await ctx.db.get(userId);
    if (!me?.rangingSince) return [];
    const cutoff = Date.now() - NEARBY_ACTIVE_MS;
    const users = await ctx.db.query("users").collect();
    const out = [];
    for (const u of users) {
      // Only badges worn full screen right now take part.
      if (u._id === userId || !u.rangingSince || (u.lastSeenAt ?? 0) < cutoff || isDemoPhone(u.phone)) continue;
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

/**
 * The badge went full screen (on) or was taken off, minimized or closed (off).
 * Off clears this person's distances and tokens at once, so the other phone's
 * badge lets go immediately instead of waiting for the reading to go stale.
 */
export const setRanging = mutation({
  args: { userId: v.id("users"), on: v.boolean() },
  handler: async (ctx, { userId, on }) => {
    const u = await ctx.db.get(userId);
    if (!u) return;
    const now = Date.now();
    await ctx.db.patch(userId, { rangingSince: on ? (u.rangingSince ?? now) : undefined, lastSeenAt: now });
    if (on) return;
    const rows = [
      ...(await ctx.db.query("proximity").withIndex("by_pair", (q) => q.eq("a", userId)).collect()),
      ...(await ctx.db.query("proximity").collect()).filter((r) => r.b === userId),
    ];
    for (const r of rows) await ctx.db.delete(r._id);
    const mine = await ctx.db.query("nearbyTokens").withIndex("by_owner_peer", (q) => q.eq("userId", userId)).collect();
    const theirs = (await ctx.db.query("nearbyTokens").collect()).filter((t) => t.peerId === userId);
    for (const t of [...mine, ...theirs]) await ctx.db.delete(t._id);
  },
});

/** Called by the phone about twice a second per peer while both badges are worn. */
export const reportDistance = mutation({
  args: { userId: v.id("users"), peerId: v.id("users"), meters: v.number() },
  handler: async (ctx, { userId, peerId, meters }) => {
    const now = Date.now();
    // A late reading from a phone that already took its badge off doesn't count.
    const [me, them] = await Promise.all([ctx.db.get(userId), ctx.db.get(peerId)]);
    if (!me?.rangingSince || !them?.rangingSince) return;
    const pair = canonicalPair(userId, peerId);
    const row = await ctx.db
      .query("proximity")
      .withIndex("by_pair", (q) => q.eq("a", pair.a).eq("b", pair.b))
      .unique();

    // Close within talking distance; once close, stay close until clearly apart
    // (both phones report here and readings jitter around the threshold).
    const wasClose = row?.closeSince !== undefined;
    const close = meters <= TALK_DISTANCE_M || (wasClose && meters <= TALK_EXIT_DISTANCE_M);
    const closeSince = close ? (row?.closeSince ?? now) : undefined;
    if (row) {
      await ctx.db.patch(row._id, { meters, at: now, closeSince, minMeters: Math.min(row.minMeters, meters) });
    } else {
      await ctx.db.insert("proximity", { ...pair, meters, at: now, closeSince, minMeters: meters });
    }
    if (closeSince === undefined) return;

    // Only matched pairs: strangers standing in line together have not "met".
    if (!(await isMatch(ctx, userId, peerId))) return;
    // Just came close: they met. Each shows up in the other's People list.
    if (!wasClose) await markMet(ctx, userId, peerId);
    // Close long enough: open a conversation if none is open for this pair.
    if (now - closeSince >= TALK_AFTER_MS) await openConversation(ctx, pair.a, pair.b);
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
