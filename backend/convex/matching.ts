import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { askClaudeJSON, claudeAvailable } from "./lib/claude";
import { loadRubric } from "./lib/rubric";
import { combine, keywordScore, Profile } from "./lib/scoring";

/**
 * Matching pipeline (see lib/scoring.ts for the math):
 *   1. For each viewer, Claude reads the viewer's profile and every candidate
 *      and estimates needFit in both directions, values affinity, the one tag
 *      of the candidate the viewer cares about, and a one line reason.
 *   2. We combine those into a reciprocal score with the editable rubric.
 *   3. Directed rows land in `matches`; badge state, heads up texts and
 *      recaps all read from there.
 */

function toProfile(u: Doc<"users">): Profile {
  return {
    id: u._id,
    name: u.name,
    headline: u.headline,
    tags: u.tags,
    lookingFor: u.lookingFor,
    offers: u.offers,
    hobbies: u.hobbies,
  };
}

function hasProfile(u: Doc<"users">) {
  return Boolean(u.name && (u.tags?.length || u.headline || u.lookingFor));
}

export const context = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return { users: users.filter(hasProfile), rubric: await loadRubric(ctx) };
  },
});

export const saveScores = internalMutation({
  args: {
    viewer: v.id("users"),
    rows: v.array(
      v.object({
        other: v.id("users"),
        score: v.number(),
        tag: v.optional(v.string()),
        reason: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { viewer, rows }) => {
    const now = Date.now();
    for (const r of rows) {
      const existing = await ctx.db
        .query("matches")
        .withIndex("by_pair", (q) => q.eq("viewer", viewer).eq("other", r.other))
        .unique();
      if (existing) await ctx.db.patch(existing._id, { ...r, updatedAt: now });
      else await ctx.db.insert("matches", { viewer, ...r, updatedAt: now });
    }
  },
});

type ScoringContext = {
  users: Doc<"users">[];
  rubric: { needWeight: number; valuesWeight: number; threshold: number; notes: string };
};

type ClaudeRow = {
  id: string;
  needFitMe: number;
  needFitThem: number;
  values: number;
  tag?: string;
  reason?: string;
};

export const scoreViewer = internalAction({
  args: { viewerId: v.id("users") },
  handler: async (ctx, { viewerId }) => {
    const { users, rubric }: ScoringContext = await ctx.runQuery(internal.matching.context, {});
    const viewer = users.find((u) => u._id === viewerId);
    if (!viewer) return;
    const candidates = users.filter((u) => u._id !== viewerId);
    if (candidates.length === 0) return;

    let rows: { other: Id<"users">; score: number; tag?: string; reason?: string }[];

    if (claudeAvailable()) {
      const result = await askClaudeJSON<ClaudeRow[]>(
        `You are the matchmaker for an in-person event. For the viewer, rate each candidate.
needFitMe: 0..1, how well the candidate can help with what the viewer is looking for.
needFitThem: 0..1, how well the viewer can help with what the candidate is looking for.
values: 0..1, how likely they click as people (values, energy, interests; underlying values matter more than identical hobbies).
tag: copy exactly ONE of the candidate's tags that the viewer would care about most.
reason: one short, specific sentence the viewer would find convincing, addressed to the viewer.
Rubric notes from organizers: ${rubric.notes}`,
        `Viewer: ${JSON.stringify(toProfile(viewer))}
Candidates: ${JSON.stringify(candidates.map(toProfile))}
Return a JSON array with one object per candidate: {"id","needFitMe","needFitThem","values","tag","reason"}.`,
        4000,
      );
      const byId = new Map(result.map((r) => [r.id, r]));
      rows = candidates.map((c) => {
        const r = byId.get(c._id);
        if (!r) return { other: c._id, ...keywordScore(toProfile(viewer), toProfile(c), rubric) };
        const tag = c.tags?.includes(r.tag ?? "") ? r.tag : c.tags?.[0];
        return {
          other: c._id,
          score: combine(Number(r.needFitMe), Number(r.needFitThem), Number(r.values), rubric),
          tag,
          reason: r.reason,
        };
      });
    } else {
      rows = candidates.map((c) => ({
        other: c._id,
        ...keywordScore(toProfile(viewer), toProfile(c), rubric),
      }));
    }
    await ctx.runMutation(internal.matching.saveScores, { viewer: viewerId, rows });
  },
});

/** Re-score everyone. Cheap at hackathon scale (one Claude call per person). */
export const rescoreAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const { users }: ScoringContext = await ctx.runQuery(internal.matching.context, {});
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
