import { query } from "./_generated/server";
import { v } from "convex/values";
import { QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { canonicalPair } from "./lib/pairs";
import { avatarOf } from "./lib/avatar";

/** Public profile fields only (no phone, no password). */
async function publicProfile(ctx: QueryCtx, u: Doc<"users"> | null) {
  if (!u) return null;
  const avatar = avatarOf(u);
  return {
    id: u._id,
    name: u.name,
    headline: u.headline,
    company: u.company,
    location: u.location,
    tags: u.tags ?? [],
    hobbies: u.hobbies ?? [],
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    photoUrl: u.photoId ? await ctx.storage.getUrl(u.photoId) : null,
  };
}

/** The People tab: everyone I saved, newest first. */
export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const conns = await ctx.db
      .query("connections")
      .withIndex("by_owner", (q) => q.eq("owner", userId))
      .order("desc")
      .collect();
    const out = [];
    for (const c of conns) {
      const other = await publicProfile(ctx, await ctx.db.get(c.other));
      if (!other) continue;
      const pair = canonicalPair(userId, c.other);
      const convo = await ctx.db
        .query("conversations")
        .withIndex("by_pair", (q) => q.eq("a", pair.a).eq("b", pair.b))
        .order("desc")
        .first();
      out.push({ ...other, connectedAt: c.at, lastSummary: convo?.summary });
    }
    return out;
  },
});

/** One person: profile, latest conversation summary, my follow up, timeline. */
export const detail = query({
  args: { userId: v.id("users"), otherId: v.id("users") },
  handler: async (ctx, { userId, otherId }) => {
    const other = await publicProfile(ctx, await ctx.db.get(otherId));
    if (!other) return null;
    const pair = canonicalPair(userId, otherId);
    const convo = await ctx.db
      .query("conversations")
      .withIndex("by_pair", (q) => q.eq("a", pair.a).eq("b", pair.b))
      .order("desc")
      .first();
    const timeline = await ctx.db
      .query("activity")
      .withIndex("by_owner_other", (q) => q.eq("owner", userId).eq("other", otherId))
      .order("asc")
      .collect();
    const connection = await ctx.db
      .query("connections")
      .withIndex("by_pair", (q) => q.eq("owner", userId).eq("other", otherId))
      .unique();
    return {
      person: other,
      connectedAt: connection?.at,
      conversation: convo
        ? {
            startedAt: convo.startedAt,
            endedAt: convo.endedAt,
            summary: convo.summary,
            topics: convo.topics ?? [],
            followUp: pair.a === userId ? convo.followUpForA : convo.followUpForB,
          }
        : null,
      timeline: timeline.map((t) => ({ kind: t.kind, text: t.text, at: t.at })),
    };
  },
});

/**
 * For the iPhone Duo: who to show when it opens. The person I'm talking with
 * or most recently talked with or saved; heads ups and intros don't count.
 */
export const current = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const latest = await ctx.db
      .query("activity")
      .withIndex("by_owner", (q) => q.eq("owner", userId))
      .order("desc")
      .filter((q) => q.or(q.eq(q.field("kind"), "talked"), q.eq(q.field("kind"), "saved")))
      .first();
    return latest?.other ?? null;
  },
});
