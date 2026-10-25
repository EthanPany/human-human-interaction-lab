import { mutation, query, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { normalizePhone } from "./lib/phone";
import { otherOf } from "./lib/pairs";
import { DEFAULT_RUBRIC } from "./lib/constants";
import { log } from "./lib/activity";
import { profilePatch, touchesMatching } from "./users";
import { requestRescore } from "./lib/rescore";

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
    if (!user) return { user: null, missingProfileFields: [], pendingContact: null, topMatches: [], recentTexts: [] };

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
      .take(5);
    const now = Date.now();
    const topMatches = [];
    for (const m of matches) {
      const o = await ctx.db.get(m.other);
      if (!o) continue;
      const saved = await ctx.db
        .query("connections")
        .withIndex("by_pair", (q) => q.eq("owner", user._id).eq("other", m.other))
        .unique();
      topMatches.push({
        name: o.name,
        headline: o.headline,
        company: o.company,
        tags: o.tags,
        lookingFor: o.lookingFor,
        offers: o.offers,
        appearance: o.appearance,
        hereNow: o.lastSeenAt !== undefined && now - o.lastSeenAt < 10 * 60_000,
        alreadySaved: Boolean(saved),
        score: m.score,
        reason: m.reason,
      });
    }

    // Texts the agent sent on its own (heads ups, recaps, contact prompts), so
    // a reply like "Y" or "yes intro me" makes sense.
    const recentTexts = (
      await ctx.db
        .query("outbox")
        .withIndex("by_phone", (q) => q.eq("phone", user.phone).gt("at", now - 12 * 3600_000))
        .collect()
    )
      .filter((t) => t.sentAt !== undefined && !t.failed)
      .slice(-6)
      .map((t) => ({ minutesAgo: Math.round((now - t.at) / 60_000), text: t.body }));

    const { password, seekEmbedding, aboutEmbedding, photoId, ...profile } = user;
    const missing = (["name", "headline", "lookingFor", "offers", "appearance"] as const).filter(
      (k) => !profile[k],
    );
    return { user: profile, missingProfileFields: missing, pendingContact, topMatches, recentTexts };
  },
});

/** STOP / START: pause or resume texts the agent sends on its own. */
export const setTextsPaused = mutation({
  args: { phone: v.string(), paused: v.boolean() },
  handler: async (ctx, { phone, paused }) => {
    const user = await userByPhone(ctx, phone);
    if (user) await ctx.db.patch(user._id, { textsPaused: paused });
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
      californiaMode: false,
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
    if (touchesMatching(patch)) await requestRescore(ctx, user._id);
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
