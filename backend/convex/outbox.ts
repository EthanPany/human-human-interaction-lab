import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Live query the agent worker subscribes to
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
