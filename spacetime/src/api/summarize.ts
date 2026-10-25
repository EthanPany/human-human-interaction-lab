import type { ProcedureCtx } from "spacetimedb/server";
import type { S } from "../schema";
import { askClaudeJSON, objectSchema } from "../lib/claude";

/** Port of conversations.summarize: Claude turns the transcript into a summary, topics and follow ups. */
export function summarizeConversation(ctx: ProcedureCtx<S>, conversationId: string) {
  const data = ctx.withTx((tx) => {
    const c = tx.db.conversations.id.find(conversationId);
    if (!c) return null;
    return { c, a: tx.db.users.id.find(c.a), b: tx.db.users.id.find(c.b) };
  });
  if (!data) return;
  const { c, a, b } = data;
  const transcript = c.transcript?.trim();

  let patch: { summary: string; topics: string[]; followUpForA?: string; followUpForB?: string };
  if (!transcript || !ctx.env.ANTHROPIC_API_KEY) {
    patch = { summary: transcript ? transcript.slice(0, 280) : "No recording for this conversation.", topics: [] };
  } else {
    const result = askClaudeJSON<{ summary: string; topics: string[]; followUpForA: string; followUpForB: string }>(
      ctx.http,
      ctx.env,
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
    patch = {
      summary: String(result.summary ?? ""),
      topics: Array.isArray(result.topics) ? result.topics.map(String).slice(0, 4) : [],
      followUpForA: result.followUpForA ? String(result.followUpForA) : undefined,
      followUpForB: result.followUpForB ? String(result.followUpForB) : undefined,
    };
  }
  ctx.withTx((tx) => {
    const row = tx.db.conversations.id.find(conversationId);
    if (row) tx.db.conversations.id.update({ ...row, ...patch });
  });
}
