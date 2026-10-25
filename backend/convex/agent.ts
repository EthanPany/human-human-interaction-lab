import { mutation, query, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { normalizePhone } from "./lib/phone";
import { otherOf } from "./lib/pairs";
import { DEFAULT_RUBRIC } from "./lib/constants";
import { log } from "./lib/activity";
import { profilePatch } from "./users";

/**
 * The API the text agent worker uses. Everything is keyed by the phone number
 * the message came from. No auth: demo only.
 */

async function userByPhone(ctx: QueryCtx, phone: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_phone", (q) => q.eq("phone", normalizePhone(phone)))
    .unique();
}

/** What the agent should know before replying. */
export const context = query({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const user = await userByPhone(ctx, phone);
    if (!user) return { user: null, pendingContact: null, topMatches: [] };

    // Most recent finished conversation that I have not saved yet.
    const convos = [
      ...(await ctx.db.query("conversations").withIndex("by_a", (q) => q.eq("a", user._id)).collect()),
      ...(await ctx.db.query("conversations").withIndex("by_b", (q) => q.eq("b", user._id)).collect()),
    ].sort((x, y) => y.startedAt - x.startedAt);
    let pendingContact = null;
    for (const c of convos) {
      if (c.endedAt === undefined) continue;
      const other = otherOf(c, user._id);
      const saved = await ctx.db
        .query("connections")
        .withIndex("by_pair", (q) => q.eq("owner", user._id).eq("other", other))
        .unique();
      if (!saved) {
        const o = await ctx.db.get(other);
        pendingContact = { userId: other, name: o?.name ?? "them" };
      }
      break;
    }

    const matches = await ctx.db
      .query("matches")
      .withIndex("by_viewer", (q) => q.eq("viewer", user._id))
      .order("desc")
      .take(3);
    const topMatches = [];
    for (const m of matches) {
      const o = await ctx.db.get(m.other);
      topMatches.push({ name: o?.name, headline: o?.headline, score: m.score, reason: m.reason });
    }

    const { password, ...profile } = user;
    return { user: profile, pendingContact, topMatches };
  },
});

/** Someone texted first: make sure they have an account. */
export const ensureUser = mutation({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const existing = await userByPhone(ctx, phone);
    if (existing) return existing._id;
    return await ctx.db.insert("users", {
      phone: normalizePhone(phone),
      californiaMode: true,
      recordConversations: true,
    });
  },
});

/** Save profile fields the agent learned over text. */
export const saveProfile = mutation({
  args: { phone: v.string(), patch: profilePatch },
  handler: async (ctx, { phone, patch }) => {
    const user = await userByPhone(ctx, phone);
    if (!user) throw new Error("No user for this phone");
    await ctx.db.patch(user._id, patch);
    await ctx.scheduler.runAfter(0, internal.matching.rescoreAll, {});
  },
});

/** "Y" after a conversation: save the most recent unsaved person. */
export const confirmContact = mutation({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const user = await userByPhone(ctx, phone);
    if (!user) return null;
    const convos = [
      ...(await ctx.db.query("conversations").withIndex("by_a", (q) => q.eq("a", user._id)).collect()),
      ...(await ctx.db.query("conversations").withIndex("by_b", (q) => q.eq("b", user._id)).collect()),
    ].sort((x, y) => y.startedAt - x.startedAt);
    for (const c of convos) {
      const other = otherOf(c, user._id);
      const saved = await ctx.db
        .query("connections")
        .withIndex("by_pair", (q) => q.eq("owner", user._id).eq("other", other))
        .unique();
      if (saved) continue;
      await ctx.db.insert("connections", { owner: user._id, other, at: Date.now() });
      const o = await ctx.db.get(other);
      await log(ctx, user._id, other, "saved", `Saved ${o?.name ?? "contact"} (confirmed by text)`);
      return o?.name ?? "them";
    }
    return null;
  },
});

/** Ditto style feedback after a conversation; the agent may also tune the rubric. */
export const addFeedback = mutation({
  args: { phone: v.string(), note: v.string(), rating: v.optional(v.number()), otherName: v.optional(v.string()) },
  handler: async (ctx, { phone, note, rating, otherName }) => {
    const user = await userByPhone(ctx, phone);
    if (!user) return;
    let other = undefined;
    if (otherName) {
      const all = await ctx.db.query("users").collect();
      other = all.find((u) => u.name?.toLowerCase() === otherName.toLowerCase())?._id;
    }
    await ctx.db.insert("feedback", { owner: user._id, other, rating, note, at: Date.now() });
  },
});

export const updateRubricNotes = mutation({
  args: { notes: v.string() },
  handler: async (ctx, { notes }) => {
    const row = await ctx.db.query("rubric").withIndex("by_name", (q) => q.eq("name", "global")).unique();
    if (row) await ctx.db.patch(row._id, { notes });
    else await ctx.db.insert("rubric", { name: "global", ...DEFAULT_RUBRIC, notes });
    await ctx.scheduler.runAfter(0, internal.matching.rescoreAll, {});
  },
});
