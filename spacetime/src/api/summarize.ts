import type { ProcedureCtx } from "spacetimedb/server";
import type { S } from "../schema";
import { askClaudeJSON, objectSchema } from "../lib/claude";
import { NO_RECORDING, releaseFollowUps } from "./followUp";
import { isGroupEncounter, memberIdsOf } from "./groups";

/**
 * Port of conversations.summarize: Claude turns the transcript into a summary, topics and follow ups.
 * Groups (three or more) get one summary that covers everyone, a few
 * highlights, and a follow up idea for each person (summarizeGroup).
 */
export function summarizeConversation(ctx: ProcedureCtx<S>, conversationId: string) {
  const data = ctx.withTx((tx) => {
    const c = tx.db.conversations.id.find(conversationId);
    if (!c) return null;
    // Dropped by both ("Drop short encounters"): no summary. Reopened since: summarize when it ends again.
    if ((tx.db.encounters.conversationId.find(conversationId)?.hiddenFor.length ?? 0) >= 2) return null;
    if (c.endedAt === undefined) return null;
    const group = isGroupEncounter(tx, c) ? memberIdsOf(tx, c).map((id) => tx.db.users.id.find(id) ?? { id }) : null;
    return { c, a: tx.db.users.id.find(c.a), b: tx.db.users.id.find(c.b), group };
  });
  if (!data) return;
  const { c, a, b, group } = data;
  if (group) return summarizeGroup(ctx, c, group);
  const transcript = c.transcript?.trim();

  let patch: { summary: string; topics: string[]; followUpForA?: string; followUpForB?: string };
  if (!transcript || !ctx.env.ANTHROPIC_API_KEY) {
    patch = { summary: transcript ? transcript.slice(0, 280) : NO_RECORDING, topics: [] };
  } else {
    let result: { summary: string; topics: string[]; followUpForA: string; followUpForB: string };
    try {
      result = askClaudeJSON<{ summary: string; topics: string[]; followUpForA: string; followUpForB: string }>(
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
    } catch (e) {
      // The follow up texts are waiting for this summary: let them go without it.
      console.error("summary failed", conversationId, e);
      ctx.withTx((tx) => releaseFollowUps(tx, conversationId));
      return;
    }
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

type Person = { id: string; name?: string; headline?: string; lookingFor?: string };

/** A group encounter: one summary for everyone, highlights, and each person's own follow up idea. */
function summarizeGroup(ctx: ProcedureCtx<S>, c: { id: string; a: string; b: string; transcript?: string }, people: Person[]) {
  const transcript = c.transcript?.trim();
  let summary: string;
  let topics: string[] = [];
  let highlights: string[] = [];
  let followUps: (string | undefined)[] = [];
  if (!transcript || !ctx.env.ANTHROPIC_API_KEY) {
    summary = transcript ? transcript.slice(0, 280) : NO_RECORDING;
  } else {
    let result: { summary: string; topics: string[]; highlights: string[]; followUps: string[] };
    try {
      result = askClaudeJSON<{ summary: string; topics: string[]; highlights: string[]; followUps: string[] }>(
        ctx.http,
        ctx.env,
        "You summarize short in-person networking conversations between several people, for all of them. Be concrete and brief. Name people by first name.",
        `People in the conversation, in order:
${people.map((p, i) => `${i + 1}. ${JSON.stringify({ name: p.name, headline: p.headline, lookingFor: p.lookingFor })}`).join("\n")}
Transcript (speakers unlabeled, may be noisy):
${transcript.slice(0, 16000)}

summary: 2 to 4 sentences covering what the group talked about and who brought what. topics: up to 4 short topics. highlights: up to 4 short moments or quotes worth remembering, under 20 words each. followUps: one entry per person above, in the same order: one concrete follow up that person could send the others.`,
        objectSchema({
          summary: { type: "string" },
          topics: { type: "array", items: { type: "string" } },
          highlights: { type: "array", items: { type: "string" } },
          followUps: { type: "array", items: { type: "string" } },
        }),
      );
    } catch (e) {
      console.error("group summary failed", c.id, e);
      ctx.withTx((tx) => releaseFollowUps(tx, c.id));
      return;
    }
    summary = String(result.summary ?? "");
    topics = Array.isArray(result.topics) ? result.topics.map(String).slice(0, 4) : [];
    highlights = Array.isArray(result.highlights) ? result.highlights.map(String).filter(Boolean).slice(0, 4) : [];
    followUps = Array.isArray(result.followUps) ? result.followUps.map((f) => (f ? String(f) : undefined)) : [];
  }
  ctx.withTx((tx) => {
    const row = tx.db.conversations.id.find(c.id);
    if (!row) return;
    const ideaFor = (id: string) => followUps[people.findIndex((p) => p.id === id)];
    tx.db.conversations.id.update({ ...row, summary, topics, followUpForA: ideaFor(row.a), followUpForB: ideaFor(row.b) });
    for (const m of [...tx.db.encounterMembers.conversationId.filter(c.id)]) {
      const idea = ideaFor(m.userId);
      if (idea !== m.followUp) tx.db.encounterMembers.id.update({ ...m, followUp: idea });
    }
    const extra = { conversationId: c.id, highlights, at: Number(tx.timestamp.microsSinceUnixEpoch / 1000n) };
    if (tx.db.groupSummaries.conversationId.find(c.id)) tx.db.groupSummaries.conversationId.update(extra);
    else tx.db.groupSummaries.insert(extra);
  });
}
