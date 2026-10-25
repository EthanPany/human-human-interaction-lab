import { action, internalAction, internalMutation, internalQuery, mutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { askClaudeJSON, claudeAvailable, objectSchema } from "./lib/claude";
import { log } from "./lib/activity";
import { queueText } from "./lib/texts";
import { PROXIMITY_FRESH_MS, STALE_CONVERSATION_MS } from "./lib/constants";

/** Open a conversation for this canonical pair if one is not already open. */
export async function openConversation(ctx: MutationCtx, a: Id<"users">, b: Id<"users">) {
  const latest = await ctx.db
    .query("conversations")
    .withIndex("by_pair", (q) => q.eq("a", a).eq("b", b))
    .order("desc")
    .first();
  if (latest && latest.endedAt === undefined) return latest._id;
  const id = await ctx.db.insert("conversations", { a, b, startedAt: Date.now() });
  const [ua, ub] = await Promise.all([ctx.db.get(a), ctx.db.get(b)]);
  await log(ctx, a, b, "talked", `Talked with ${ub?.name ?? "them"}`);
  await log(ctx, b, a, "talked", `Talked with ${ua?.name ?? "them"}`);
  return id;
}

/**
 * The phone stops recording when the badge leaves the talking state and sends
 * the on-device transcript here. Both phones may call it; the longer
 * transcript wins and the follow up texts go out once.
 */
export const finish = mutation({
  args: { conversationId: v.id("conversations"), transcript: v.optional(v.string()) },
  handler: async (ctx, { conversationId, transcript }) => {
    await endConversation(ctx, conversationId, transcript);
  },
});

/** End a conversation (idempotent). Texts go out once; summary runs after uploads settle. */
export async function endConversation(ctx: MutationCtx, conversationId: Id<"conversations">, transcript?: string) {
  const c = await ctx.db.get(conversationId);
  if (!c) return;
  const longer = (transcript?.length ?? 0) > (c.transcript?.length ?? 0) ? transcript : c.transcript;
  const firstFinish = c.endedAt === undefined;
  await ctx.db.patch(conversationId, { endedAt: c.endedAt ?? Date.now(), transcript: longer });

  if (firstFinish) {
    const [ua, ub] = await Promise.all([ctx.db.get(c.a), ctx.db.get(c.b)]);
    for (const [me, them] of [[ua, ub], [ub, ua]] as const) {
      if (!me || !them) continue;
      await queueText(
        ctx,
        me.phone,
        `Looks like you just talked with ${them.name ?? "someone"}${them.headline ? ` (${them.headline})` : ""}. Save their contact? Reply Y`,
      );
    }
  }
  // Summarize after the second phone has had a moment to upload too.
  if (firstFinish || transcript) {
    await ctx.scheduler.runAfter(8_000, internal.conversations.summarize, { conversationId });
  }
}

/**
 * Safety net (cron): end conversations whose phones stopped reporting or who
 * are no longer close, in case an app died before calling finish.
 */
export const closeStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const open = await ctx.db
      .query("conversations")
      .filter((q) => q.eq(q.field("endedAt"), undefined))
      .collect();
    for (const c of open) {
      if (now - c.startedAt < STALE_CONVERSATION_MS) continue;
      const row = await ctx.db
        .query("proximity")
        .withIndex("by_pair", (q) => q.eq("a", c.a).eq("b", c.b))
        .unique();
      const fresh = row && now - row.at < PROXIMITY_FRESH_MS;
      const stillClose = fresh && row.closeSince !== undefined;
      if (!stillClose) await endConversation(ctx, c._id);
    }
  },
});

export const get = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const c = await ctx.db.get(conversationId);
    if (!c) return null;
    const [a, b] = await Promise.all([ctx.db.get(c.a), ctx.db.get(c.b)]);
    return { c, a, b };
  },
});

export const saveSummary = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    summary: v.string(),
    topics: v.array(v.string()),
    followUpForA: v.optional(v.string()),
    followUpForB: v.optional(v.string()),
  },
  handler: async (ctx, { conversationId, ...rest }) => {
    await ctx.db.patch(conversationId, rest);
  },
});

/** Claude turns the transcript into a summary, topics and follow ups. */
export const summarize = internalAction({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const data = await ctx.runQuery(internal.conversations.get, { conversationId });
    if (!data) return;
    const { c, a, b } = data;
    const transcript = c.transcript?.trim();
    if (!transcript || !claudeAvailable()) {
      await ctx.runMutation(internal.conversations.saveSummary, {
        conversationId,
        summary: transcript ? transcript.slice(0, 280) : "No recording for this conversation.",
        topics: [],
      });
      return;
    }
    let result: { summary: string; topics: string[]; followUpForA: string; followUpForB: string };
    try {
      result = await askClaudeJSON<typeof result>(
        "You summarize short in-person networking conversations for both participants. Be concrete and brief.",
        `Person A: ${JSON.stringify({ name: a?.name, headline: a?.headline, lookingFor: a?.lookingFor })}
Person B: ${JSON.stringify({ name: b?.name, headline: b?.headline, lookingFor: b?.lookingFor })}
Transcript (speakers unlabeled, may be noisy):
${transcript.slice(0, 12000)}

summary: 2 to 3 sentences. topics: up to 4 short topics. followUpForA: one concrete follow up A could send B. followUpForB: one concrete follow up B could send A.`,
        objectSchema({
          summary: { type: "string" },
          topics: { type: "array", items: { type: "string" } },
          followUpForA: { type: "string" },
          followUpForB: { type: "string" },
        }),
      );
    } catch (e) {
      // Still show something on the person's profile rather than waiting forever.
      console.error("summary failed", e);
      await ctx.runMutation(internal.conversations.saveSummary, {
        conversationId,
        summary: transcript.slice(0, 280),
        topics: [],
      });
      return;
    }
    await ctx.runMutation(internal.conversations.saveSummary, {
      conversationId,
      summary: String(result.summary ?? ""),
      topics: Array.isArray(result.topics) ? result.topics.map(String).slice(0, 4) : [],
      followUpForA: result.followUpForA ? String(result.followUpForA) : undefined,
      followUpForB: result.followUpForB ? String(result.followUpForB) : undefined,
    });
  },
});

/** Manual trigger for testing. */
export const resummarize = action({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await ctx.runAction(internal.conversations.summarize, args);
  },
});
