import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { queueText } from "./lib/texts";

/** Queue a text from an action or the scheduler. Mutations call queueText directly. */
export const enqueue = internalMutation({
  args: { phone: v.string(), body: v.string() },
  handler: async (ctx, { phone, body }) => queueText(ctx, phone, body),
});

/** Live query the agent worker subscribes to. */
export const pending = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("outbox")
      .withIndex("by_unsent", (q) => q.eq("sentAt", undefined))
      .take(50);
  },
});

export const markSent = mutation({
  args: { id: v.id("outbox") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { sentAt: Date.now() });
  },
});
