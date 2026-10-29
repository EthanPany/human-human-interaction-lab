import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { canonicalPair, otherOf } from "./lib/pairs";
import { avatarOf } from "./lib/avatar";
import { log } from "./lib/activity";

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

/**
 * Record that a matched pair met in person (came within talking distance).
 * Idempotent: the first time adds a "Met" line to both timelines and puts each
 * person in the other's People list; later calls only bump lastAt.
 */
export async function markMet(ctx: MutationCtx, x: Id<"users">, y: Id<"users">) {
  if (x === y) return;
  const { a, b } = canonicalPair(x, y);
  const now = Date.now();
  const existing = await ctx.db
    .query("meetings")
    .withIndex("by_pair", (q) => q.eq("a", a).eq("b", b))
    .unique();
  if (existing) {
    if (now - existing.lastAt > 5_000) await ctx.db.patch(existing._id, { lastAt: now });
    return;
  }
  await ctx.db.insert("meetings", { a, b, firstAt: now, lastAt: now });
  const [ua, ub] = await Promise.all([ctx.db.get(a), ctx.db.get(b)]);
  await log(ctx, a, b, "met", `Met ${ub?.name ?? "them"}`);
  await log(ctx, b, a, "met", `Met ${ua?.name ?? "them"}`);
}

/** The phone calls this at the "we finally met" moment (its own UWB reading). */
export const met = mutation({
  args: { userId: v.id("users"), otherId: v.id("users") },
  handler: async (ctx, { userId, otherId }) => {
    await markMet(ctx, userId, otherId);
  },
});

/**
 * The People tab: everyone I saved or met in person, newest first.
 * `connectedAt` is when they joined the list (saved, or first met); `saved`
 * says whether I saved their contact.
 */
export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const conns = await ctx.db
      .query("connections")
      .withIndex("by_owner", (q) => q.eq("owner", userId))
      .collect();
    const meetings = [
      ...(await ctx.db.query("meetings").withIndex("by_a", (q) => q.eq("a", userId)).collect()),
      ...(await ctx.db.query("meetings").withIndex("by_b", (q) => q.eq("b", userId)).collect()),
    ];
    const entries = new Map<Id<"users">, { at: number; saved: boolean }>();
    for (const m of meetings) entries.set(otherOf(m, userId), { at: m.firstAt, saved: false });
    for (const c of conns) {
      const met = entries.get(c.other);
      entries.set(c.other, { at: met ? Math.min(met.at, c.at) : c.at, saved: true });
    }
    const out = [];
    for (const [otherId, entry] of entries) {
      const other = await publicProfile(ctx, await ctx.db.get(otherId));
      if (!other) continue;
      const pair = canonicalPair(userId, otherId);
      const convo = await ctx.db
        .query("conversations")
        .withIndex("by_pair", (q) => q.eq("a", pair.a).eq("b", pair.b))
        .order("desc")
        .first();
      out.push({ ...other, connectedAt: entry.at, saved: entry.saved, lastSummary: convo?.summary });
    }
    return out.sort((x, y) => y.connectedAt - x.connectedAt);
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
    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_pair", (q) => q.eq("a", pair.a).eq("b", pair.b))
      .unique();
    return {
      person: other,
      connectedAt: connection?.at,
      saved: connection !== null,
      metAt: meeting?.firstAt,
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
 * or most recently met, talked with or saved; heads ups and intros don't count.
 */
export const current = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const latest = await ctx.db
      .query("activity")
      .withIndex("by_owner", (q) => q.eq("owner", userId))
      .order("desc")
      .filter((q) =>
        q.or(q.eq(q.field("kind"), "met"), q.eq(q.field("kind"), "talked"), q.eq(q.field("kind"), "saved")),
      )
      .first();
    return latest?.other ?? null;
  },
});
