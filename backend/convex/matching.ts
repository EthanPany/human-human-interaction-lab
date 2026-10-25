import { action, ActionCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { askClaudeJSON, claudeAvailable, objectSchema } from "./lib/claude";
import { loadRubric } from "./lib/rubric";
import { combine, keywordScore, pickTag, Profile } from "./lib/scoring";
import { aboutText, embed, embeddingsAvailable, seekText } from "./lib/embeddings";
import { MAX_SCORED_CANDIDATES } from "./lib/constants";

/**
 * Matching pipeline (see lib/scoring.ts for the math):
 *   0. Candidates. With embeddings on and a big crowd, only the people nearest
 *      to the viewer in both directions (they fit my needs, I fit theirs) go on.
 *   1. One Claude call per viewer rates every candidate: needFit both ways,
 *      values affinity, plus a tag and a reason for EACH side.
 *   2. The score is reciprocal and symmetric (sqrt(fitMe*fitThem) and values),
 *      so one call fills both directed rows: viewer->other and other->viewer.
 *   3. Rows land in `matches`; badge state, heads up texts and recaps read them.
 *
 * Profile edits are debounced, and only the edited person is re-scored.
 */

function toProfile(u: Doc<"users">): Profile {
  return {
    id: u._id,
    name: u.name,
    headline: u.headline,
    company: u.company,
    tags: u.tags,
    lookingFor: u.lookingFor,
    offers: u.offers,
    hobbies: u.hobbies,
  };
}

function hasProfile(u: Doc<"users">) {
  return Boolean(u.name && (u.tags?.length || u.headline || u.lookingFor));
}

type MatchRow = { viewer: Id<"users">; other: Id<"users">; score: number; tag?: string; reason?: string };

type ScoringContext = {
  users: Doc<"users">[];
  rubric: { needWeight: number; valuesWeight: number; threshold: number; notes: string };
};

export const context = internalQuery({
  args: {},
  handler: async (ctx): Promise<ScoringContext> => {
    const users = await ctx.db.query("users").collect();
    return { users: users.filter(hasProfile), rubric: await loadRubric(ctx) };
  },
});

export const saveScores = internalMutation({
  args: {
    rows: v.array(
      v.object({
        viewer: v.id("users"),
        other: v.id("users"),
        score: v.number(),
        tag: v.optional(v.string()),
        reason: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    const now = Date.now();
    for (const r of rows) {
      const existing = await ctx.db
        .query("matches")
        .withIndex("by_pair", (q) => q.eq("viewer", r.viewer).eq("other", r.other))
        .unique();
      if (existing) await ctx.db.patch(existing._id, { ...r, updatedAt: now });
      else await ctx.db.insert("matches", { ...r, updatedAt: now });
    }
  },
});

type ClaudeRow = {
  id: string;
  needFitMe: number;
  needFitThem: number;
  values: number;
  tagForViewer?: string;
  reasonForViewer?: string;
  tagForCandidate?: string;
  reasonForCandidate?: string;
};

const RATINGS_SCHEMA = objectSchema({
  ratings: {
    type: "array",
    items: objectSchema({
      id: { type: "string" },
      needFitMe: { type: "number" },
      needFitThem: { type: "number" },
      values: { type: "number" },
      tagForViewer: { type: "string" },
      reasonForViewer: { type: "string" },
      tagForCandidate: { type: "string" },
      reasonForCandidate: { type: "string" },
    }),
  },
});

/** Keep a tag only if it really is one of that person's tags. */
function validTag(tags: string[] | undefined, tag: string | undefined) {
  return tag && tags?.includes(tag) ? tag : tags?.[0];
}

export const scoreViewer = internalAction({
  args: { viewerId: v.id("users") },
  handler: async (ctx, { viewerId }) => {
    const { users, rubric }: ScoringContext = await ctx.runQuery(internal.matching.context, {});
    const viewer = users.find((u) => u._id === viewerId);
    if (!viewer) return;
    let candidates = users.filter((u) => u._id !== viewerId);
    if (candidates.length === 0) return;

    if (candidates.length > MAX_SCORED_CANDIDATES && viewer.seekEmbedding && viewer.aboutEmbedding) {
      const half = Math.ceil(MAX_SCORED_CANDIDATES / 2);
      const [fitMe, fitThem] = await Promise.all([
        ctx.vectorSearch("users", "by_about", { vector: viewer.seekEmbedding, limit: half + 1 }),
        ctx.vectorSearch("users", "by_seek", { vector: viewer.aboutEmbedding, limit: half + 1 }),
      ]);
      const keep = new Set([...fitMe, ...fitThem].map((r) => r._id));
      candidates = candidates.filter((c) => keep.has(c._id));
    }

    const me = toProfile(viewer);
    const fallback = (c: Doc<"users">): MatchRow[] => {
      const them = toProfile(c);
      const forward = keywordScore(me, them, rubric);
      return [
        { viewer: viewerId, other: c._id, ...forward },
        { viewer: c._id, other: viewerId, score: forward.score, tag: pickTag(them, me) },
      ];
    };

    let rows: MatchRow[];
    let result: ClaudeRow[] | null = null;
    if (claudeAvailable()) {
      try {
        const reply = await askClaudeJSON<{ ratings: ClaudeRow[] }>(
        `You are the matchmaker for an in-person event. Rate the viewer against each candidate.
needFitMe: 0..1, how well the candidate can help with what the viewer is looking for.
needFitThem: 0..1, how well the viewer can help with what the candidate is looking for.
values: 0..1, how likely they click as people (values, energy, interests; underlying values matter more than identical hobbies).
tagForViewer: copy exactly ONE of the candidate's tags that the viewer would care about most.
reasonForViewer: one short, specific sentence telling the viewer why to meet the candidate.
tagForCandidate: copy exactly ONE of the viewer's tags that the candidate would care about most.
reasonForCandidate: one short, specific sentence telling the candidate why to meet the viewer.
Rubric notes from organizers: ${rubric.notes}`,
        `Viewer: ${JSON.stringify(me)}
Candidates: ${JSON.stringify(candidates.map(toProfile))}
Return one rating per candidate, using the candidate's id.`,
          RATINGS_SCHEMA,
          Math.min(8000, 400 + candidates.length * 220),
        );
        result = reply.ratings;
      } catch (e) {
        console.error("Claude scoring failed, using keyword fallback", e);
      }
    }
    if (Array.isArray(result)) {
      const byId = new Map(result.map((r) => [r.id, r]));
      rows = candidates.flatMap((c): MatchRow[] => {
        const r = byId.get(c._id);
        if (!r) return fallback(c);
        const score = combine(Number(r.needFitMe), Number(r.needFitThem), Number(r.values), rubric);
        return [
          { viewer: viewerId, other: c._id, score, tag: validTag(c.tags, r.tagForViewer), reason: r.reasonForViewer },
          { viewer: c._id, other: viewerId, score, tag: validTag(viewer.tags, r.tagForCandidate), reason: r.reasonForCandidate },
        ];
      });
    } else {
      rows = candidates.flatMap(fallback);
    }
    await ctx.runMutation(internal.matching.saveScores, { rows });
  },
});

export const saveEmbeddings = internalMutation({
  args: { userId: v.id("users"), seek: v.array(v.float64()), about: v.array(v.float64()) },
  handler: async (ctx, { userId, seek, about }) => {
    await ctx.db.patch(userId, { seekEmbedding: seek, aboutEmbedding: about });
  },
});

async function refreshEmbeddings(ctx: ActionCtx, u: Doc<"users">) {
  if (!embeddingsAvailable()) return;
  try {
    const [seek, about] = await embed([seekText(u), aboutText(u)]);
    await ctx.runMutation(internal.matching.saveEmbeddings, { userId: u._id, seek, about });
  } catch (e) {
    console.error("embedding failed", e);
  }
}

/**
 * A profile changed. Scheduled with a delay by `requestRescore`; if another
 * edit landed in the meantime, this run steps aside for the later one.
 */
export const profileChanged = internalAction({
  args: { userId: v.id("users"), requestedAt: v.number() },
  handler: async (ctx, { userId, requestedAt }) => {
    const { users }: ScoringContext = await ctx.runQuery(internal.matching.context, {});
    const u = users.find((x) => x._id === userId);
    if (!u) return;
    if ((u.profileUpdatedAt ?? 0) > requestedAt) return; // a newer edit will handle it
    await refreshEmbeddings(ctx, u);
    await ctx.runAction(internal.matching.scoreViewer, { viewerId: userId });
  },
});

/** Re-score everyone (seed, rubric change). One Claude call per person. */
export const rescoreAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const { users }: ScoringContext = await ctx.runQuery(internal.matching.context, {});
    for (const u of users) if (!u.aboutEmbedding) await refreshEmbeddings(ctx, u);
    for (const u of users) {
      try {
        await ctx.runAction(internal.matching.scoreViewer, { viewerId: u._id });
      } catch (e) {
        console.error("scoring failed for", u._id, e);
      }
    }
  },
});

/** Manual trigger: npx convex run matching:rescore */
export const rescore = action({
  args: {},
  handler: async (ctx) => {
    await ctx.runAction(internal.matching.rescoreAll, {});
  },
});

