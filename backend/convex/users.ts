import { mutation, query, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { normalizePhone } from "./lib/phone";
import { queueText } from "./lib/texts";

/** Profile fields the app and the agent are allowed to edit. */
export const profilePatch = v.object({
  name: v.optional(v.string()),
  headline: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  lookingFor: v.optional(v.string()),
  offers: v.optional(v.string()),
  hobbies: v.optional(v.array(v.string())),
  appearance: v.optional(v.string()),
  californiaMode: v.optional(v.boolean()),
  recordConversations: v.optional(v.boolean()),
});

/** Sign up or sign in with a phone number. Password is optional for the demo. */
export const signIn = mutation({
  args: { phone: v.string(), name: v.optional(v.string()), password: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const phone = normalizePhone(args.phone);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .unique();
    if (existing) {
      if (existing.password && existing.password !== args.password) {
        throw new Error("Wrong password");
      }
      return existing._id;
    }
    const id = await ctx.db.insert("users", {
      phone,
      name: args.name,
      password: args.password || undefined,
      californiaMode: true,
      recordConversations: true,
      lastSeenAt: Date.now(),
    });
    await queueText(
      ctx,
      phone,
      "Hi! I'm your badge agent. I'll help you meet the right people here. What should I call you, and who are you hoping to meet?",
    );
    return id;
  },
});

export const me = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const u = await ctx.db.get(userId);
    if (!u) return null;
    const { password, ...rest } = u;
    return { ...rest, hasPassword: Boolean(password) };
  },
});

export const updateProfile = mutation({
  args: { userId: v.id("users"), patch: profilePatch },
  handler: async (ctx, { userId, patch }) => {
    await ctx.db.patch(userId, patch);
    // Profiles changed, so scores may have too.
    await ctx.scheduler.runAfter(0, internal.matching.rescoreAll, {});
  },
});

export const byPhone = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", normalizePhone(phone)))
      .unique();
  },
});

export const all = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("users").collect(),
});
