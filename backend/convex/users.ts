import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const signUp = mutation({
  args: {
    phone: v.string(),
    name: v.optional(v.string()),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .unique();
    if (existing) return existing._id;

    const id = await ctx.db.insert("users", {
      phone: args.phone,
      name: args.name,
      password: args.password,
      californiaMode: true,
    });
    // The agent texts first when someone signs up in the app
    await ctx.db.insert("outbox", {
      phone: args.phone,
      body: "Hi! I'm your badge agent. Who are you hoping to meet at this event?",
    });
    return id;
  },
});

export const updateProfile = mutation({
  args: {
    userId: v.id("users"),
    patch: v.object({
      name: v.optional(v.string()),
      headline: v.optional(v.string()),
      tags: v.optional(v.array(v.string())),
      lookingFor: v.optional(v.string()),
      hobbies: v.optional(v.array(v.string())),
      appearance: v.optional(v.string()),
      californiaMode: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, { userId, patch }) => {
    await ctx.db.patch(userId, patch);
  },
});

export const byPhone = query({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .unique();
  },
});
