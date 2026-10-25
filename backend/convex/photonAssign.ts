import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assignLine, lineFor, needsInboundFirst, openDirect, photonConfigured, sendText } from "./lib/photonApi";
import { isDemoPhone, normalizePhone } from "./lib/phone";

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
    if (!line) return;
    await ctx.runMutation(internal.photonAssign.save, { userId, line });

    // Try to say hi right away. A dedicated line can text first; the shared
    // pool refuses until they text in, and then the cloud agent greets them.
    const welcome = await ctx.runQuery(internal.photonAssign.pendingWelcome, { phone: u.phone });
    if (!welcome) return;
    try {
      const { spaceId, agentUserId } = await openDirect(line, u.phone);
      await sendText(spaceId, agentUserId, welcome.body, `outbox:${welcome._id}`);
      await ctx.runMutation(internal.cloudAgent.rememberConversation, { phone: u.phone, spaceId, agentUserId });
      await ctx.runMutation(internal.cloudAgent.markText, { id: welcome._id, sent: true });
    } catch (e) {
      if (needsInboundFirst(e)) console.log(`welcome for ${u.phone} waits for their first text (shared line)`);
      else console.error("welcome send failed", u.phone, e);
    }
  },
});

export const pendingWelcome = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) =>
    (await ctx.db.query("outbox").withIndex("by_phone", (q) => q.eq("phone", phone)).collect()).find(
      (t) => t.kind === "welcome" && t.sentAt === undefined,
    ) ?? null,
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

/**
 * Photon Spectrum gives each person added to the project their own line:
 * `npx convex run photonAssign:setLine '{"phone":"+15852106589","line":"+14156052974"}'`
 */
export const setLine = internalMutation({
  args: { phone: v.string(), line: v.string() },
  handler: async (ctx, { phone, line }) => {
    const u = await ctx.db.query("users").withIndex("by_phone", (q) => q.eq("phone", normalizePhone(phone))).unique();
    if (!u) return "no user with that phone";
    await ctx.db.patch(u._id, { agentLine: normalizePhone(line) });
    return `${u.name ?? u.phone}: ${normalizePhone(line)}`;
  },
});
