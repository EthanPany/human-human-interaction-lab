import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assignLine, lineFor, photonConfigured } from "./lib/photonApi";
import { isDemoPhone } from "./lib/phone";

/**
 * Every new account is added to the Photon iMessage pool automatically, so the
 * number someone signs up with is the number that can text the agent (blue
 * bubbles), with no manual step in the dashboard. The assigned line is saved
 * on the user; the app's "Text your agent" opens that line.
 */
export const ensure = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    if (!photonConfigured()) return;
    const u = await ctx.runQuery(internal.photonAssign.user, { userId });
    if (!u || u.agentLine || isDemoPhone(u.phone) || u.phone.includes("@")) return;
    let line: string | undefined;
    try {
      line = (await lineFor(u.phone)) ?? (await assignLine(u.phone));
    } catch (e) {
      console.error("Photon assignment failed", u.phone, e);
      return;
    }
    if (line) await ctx.runMutation(internal.photonAssign.save, { userId, line });
  },
});

export const user = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const u = await ctx.db.get(userId);
    return u ? { phone: u.phone, agentLine: u.agentLine } : null;
  },
});

export const save = internalMutation({
  args: { userId: v.id("users"), line: v.string() },
  handler: async (ctx, { userId, line }) => {
    await ctx.db.patch(userId, { agentLine: line });
  },
});

/** One off: assign everyone who signed up before this existed. */
export const backfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let n = 0;
    for (const u of users) {
      if (u.agentLine || isDemoPhone(u.phone)) continue;
      await ctx.scheduler.runAfter(n * 500, internal.photonAssign.ensure, { userId: u._id });
      n++;
    }
    return n;
  },
});
