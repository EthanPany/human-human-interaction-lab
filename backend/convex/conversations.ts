import { action, internalAction, internalMutation, internalQuery, mutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { askClaudeJSON, claudeAvailable } from "./lib/claude";
import { log } from "./lib/activity";
import { queueText } from "./lib/texts";

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
    const c = await ctx.db.get(conversationId);
    if (!c) return;
    const longer =
      (transcript?.length ?? 0) > (c.transcript?.length ?? 0) ? transcript : c.transcript;
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
    await ctx.scheduler.runAfter(8_000, internal.conversations.summarize, { conversationId });
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
    const result = await askClaudeJSON<{
      summary: string;
      topics: string[];
      followUpForA: string;
      followUpForB: string;
    }>(
      "You summarize short in-person networking conversations for both participants. Be concrete and brief.",
      `Person A: ${JSON.stringify({ name: a?.name, headline: a?.headline, lookingFor: a?.lookingFor })}
Person B: ${JSON.stringify({ name: b?.name, headline: b?.headline, lookingFor: b?.lookingFor })}
Transcript (speakers unlabeled, may be noisy):
${transcript.slice(0, 12000)}

Return {"summary": "2-3 sentences", "topics": ["up to 4 short topics"], "followUpForA": "one concrete follow up A could send B", "followUpForB": "one concrete follow up B could send A"}.`,
    );
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
