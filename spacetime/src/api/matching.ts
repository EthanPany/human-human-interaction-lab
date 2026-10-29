import type { ProcedureCtx } from "spacetimedb/server";
import type { S, Tx, User } from "../schema";
import { askClaudeJSON, objectSchema } from "../lib/claude";
import { MAX_SCORED_CANDIDATES } from "../lib/constants";
import { directedKey, loadRubric, nowMs } from "../lib/db";
import { combine, keywordScore, pickTag, type Profile } from "../lib/scoring";
import { jevAvailable, jevFits, type JevFit } from "../lib/jev";

/**
 * Port of backend/convex/matching.ts. Runs in procedures because it calls Jev and Claude:
 *   read profiles (transaction)
 *   -> TypeSafe Jev rates every pair (if TYPESAFE_API_KEY is set) and those scores are saved at once
 *   -> one Claude call per viewer writes the tags and reasons (and scores any pair Jev missed)
 *   -> save rows (transaction). Keyword scoring is the last fallback.
 * Differences from Convex: no Voyage embedding prefilter (no vector index here),
 * so with more than MAX_SCORED_CANDIDATES people the most recently active ones are scored.
 */

type Pctx = ProcedureCtx<S>;

function toProfile(u: User): Profile {
  return {
    id: u.id,
    name: u.name,
    headline: u.headline,
    company: u.company,
    tags: u.tags,
    lookingFor: u.lookingFor,
    offers: u.offers,
    hobbies: u.hobbies,
  };
}

function hasProfile(u: User) {
  return Boolean(u.name && (u.tags?.length || u.headline || u.lookingFor));
}

type MatchRow = { viewer: string; other: string; score: number; tag?: string; reason?: string };

function scoringContext(tx: Tx) {
  return { users: [...tx.db.users.iter()].filter(hasProfile), rubric: loadRubric(tx) };
}

function saveScores(tx: Tx, rows: MatchRow[]) {
  const now = nowMs(tx);
  for (const r of rows) {
    const row = { id: directedKey(r.viewer, r.other), ...r, tag: r.tag, reason: r.reason, updatedAt: now };
    if (tx.db.matches.id.find(row.id)) tx.db.matches.id.update(row);
    else tx.db.matches.insert(row);
  }
}

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

export function scoreViewer(ctx: Pctx, viewerId: string) {
  const { users, rubric } = ctx.withTx(scoringContext);
  const viewer = users.find((u) => u.id === viewerId);
  if (!viewer) return;
  let candidates = users.filter((u) => u.id !== viewerId);
  if (candidates.length === 0) return;
  if (candidates.length > MAX_SCORED_CANDIDATES) {
    candidates = candidates.sort((x, y) => (y.lastSeenAt ?? 0) - (x.lastSeenAt ?? 0)).slice(0, MAX_SCORED_CANDIDATES);
  }

  const me = toProfile(viewer);
  let jev = new Map<string, JevFit>();
  const fallback = (c: User): MatchRow[] => {
    const them = toProfile(c);
    const f = jev.get(c.id);
    const forward = f
      ? { ...keywordScore(me, them, rubric), score: combine(f.needFitMe, f.needFitThem, f.values, rubric) }
      : keywordScore(me, them, rubric);
    return [
      { viewer: viewerId, other: c.id, ...forward },
      { viewer: c.id, other: viewerId, score: forward.score, tag: pickTag(them, me) },
    ];
  };

  // 1. Jev (if configured) rates every pair in about half a second each and the
  //    scores go live right away, with keyword tags until Claude's arrive.
  if (jevAvailable(ctx.env)) {
    jev = jevFits(ctx.http, ctx.env, me, candidates.map(toProfile));
    if (jev.size > 0) {
      const quick = candidates.flatMap((c): MatchRow[] => {
        const f = jev.get(c.id);
        if (!f) return [];
        const score = combine(f.needFitMe, f.needFitThem, f.values, rubric);
        const them = toProfile(c);
        return [
          { viewer: viewerId, other: c.id, score, tag: pickTag(me, them) },
          { viewer: c.id, other: viewerId, score, tag: pickTag(them, me) },
        ];
      });
      ctx.withTx((tx) => saveScores(tx, quick));
    }
  }

  // 2. Claude writes the tags and reasons (and scores any pair Jev missed).
  let result: ClaudeRow[] | null = null;
  if (ctx.env.ANTHROPIC_API_KEY) {
    try {
      const reply = askClaudeJSON<{ ratings: ClaudeRow[] }>(
        ctx.http,
        ctx.env,
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

  let rows: MatchRow[];
  if (Array.isArray(result)) {
    const byId = new Map(result.map((r) => [r.id, r]));
    rows = candidates.flatMap((c): MatchRow[] => {
      const r = byId.get(c.id);
      if (!r) return fallback(c);
      const f = jev.get(c.id);
      const score = f
        ? combine(f.needFitMe, f.needFitThem, f.values, rubric)
        : combine(Number(r.needFitMe), Number(r.needFitThem), Number(r.values), rubric);
      return [
        { viewer: viewerId, other: c.id, score, tag: validTag(c.tags, r.tagForViewer), reason: r.reasonForViewer },
        { viewer: c.id, other: viewerId, score, tag: validTag(viewer.tags, r.tagForCandidate), reason: r.reasonForCandidate },
      ];
    });
  } else {
    rows = candidates.flatMap(fallback);
  }
  ctx.withTx((tx) => saveScores(tx, rows));
}

/** A profile changed; if another edit landed since, this run steps aside for the later one. */
export function profileChanged(ctx: Pctx, userId: string, requestedAt: number) {
  const u = ctx.withTx((tx) => tx.db.users.id.find(userId));
  if (!u || (u.profileUpdatedAt ?? 0) > requestedAt) return;
  scoreViewer(ctx, userId);
}

/** Re-score everyone (seed, rubric change). One Claude call per person. */
export function rescoreAll(ctx: Pctx) {
  const ids = ctx.withTx((tx) => scoringContext(tx).users.map((u) => u.id));
  for (const id of ids) {
    try {
      scoreViewer(ctx, id);
    } catch (e) {
      console.error("scoring failed for", id, e);
    }
  }
}
