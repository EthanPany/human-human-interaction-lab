import { TimeDuration } from "spacetimedb";
import type { HttpClient } from "./httpClient";

/**
 * Synchronous port of backend/convex/lib/jev.ts for SpacetimeDB procedures.
 * Fast pair scoring with TypeSafe Jev (https://docs.typesafe.ai/api), a
 * decision model that answers typed questions in about half a second.
 * Env: TYPESAFE_API_KEY (and optional JEV_MODEL). Jev rates the three numbers the score is built
 * from; Claude still writes the topics and reasons (Jev can't write text).
 *
 * Following TypeSafe's guidance for Jev 1.13: one judgment per question, only
 * the profile fields that question needs, and the arithmetic in code.
 */
import type { Profile } from "./scoring";

const API = "https://api.typesafe.ai/v1/systemone";

export type JevEnv = { TYPESAFE_API_KEY?: string; JEV_MODEL?: string };

export function jevAvailable(env: JevEnv) {
  return Boolean(env.TYPESAFE_API_KEY);
}

export type JevFit = { needFitMe: number; needFitThem: number; values: number };

const FIT_LEVELS = [
  "Not at all: nothing B has matches what A is looking for",
  "Slightly: a loose or indirect connection",
  "Somewhat: B could help with part of it",
  "Well: B clearly has what A is looking for",
  "Exactly: B is the kind of person A described",
];
const CLICK_LEVELS = [
  "Unlikely to click",
  "Some overlap",
  "Shared interests or energy",
  "Strong shared values and interests",
];

function describe(label: string, p: Profile) {
  return [
    `${label}: ${p.name ?? "Someone"}${p.headline ? `, ${p.headline}` : ""}${p.company ? ` at ${p.company}` : ""}`,
    p.tags?.length ? `${label} topics: ${p.tags.join(", ")}` : "",
    p.offers ? `${label} can offer: ${p.offers}` : "",
    p.lookingFor ? `${label} is looking for: ${p.lookingFor}` : "",
    p.hobbies?.length ? `${label} hobbies: ${p.hobbies.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Expected level from the probabilities, scaled to 0..1. */
function level(answer: { score?: number; probabilities?: Record<string, number> } | undefined, levels: number) {
  if (!answer) return undefined;
  const probs = answer.probabilities;
  const expected = probs
    ? Object.entries(probs).reduce((sum, [k, p]) => sum + Number(k) * p, 0)
    : answer.score;
  return expected === undefined ? undefined : Math.max(0, Math.min(1, expected / (levels - 1)));
}

/** Rate one pair: A is the viewer, B the candidate. Null on any failure (callers fall back). */
export function jevPairFit(http: HttpClient, env: JevEnv, a: Profile, b: Profile): JevFit | null {
  try {
    const res = http.fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.JEV_MODEL || "jev-latest",
        state: `Two attendees at a hackathon.\n\n${describe("A", a)}\n\n${describe("B", b)}`,
        questions: {
          fitMe: {
            type: "score",
            instructions: "How well does what B does or offers match what A is looking for?",
            criteria: FIT_LEVELS,
          },
          fitThem: {
            type: "score",
            instructions: "How well does what A does or offers match what B is looking for?",
            criteria: FIT_LEVELS.map((s) => s.replace("nothing B has matches what A", "nothing A has matches what B").replace("B could", "A could").replace("B clearly has what A", "A clearly has what B").replace("B is the kind of person A", "A is the kind of person B")),
          },
          values: {
            type: "score",
            instructions: "How likely are A and B to enjoy talking, judging by their topics, hobbies and what they care about?",
            criteria: CLICK_LEVELS,
          },
        },
      }),
      timeout: TimeDuration.fromMillis(15_000),
    });
    if (!res.ok) {
      console.error("Jev", res.status, res.text().slice(0, 300));
      return null;
    }
    const data = res.json() as { answers: Record<string, { score?: number; probabilities?: Record<string, number> }> };
    const fitMe = level(data.answers.fitMe, FIT_LEVELS.length);
    const fitThem = level(data.answers.fitThem, FIT_LEVELS.length);
    const values = level(data.answers.values, CLICK_LEVELS.length);
    if (fitMe === undefined || fitThem === undefined || values === undefined) return null;
    return { needFitMe: fitMe, needFitThem: fitThem, values };
  } catch (e) {
    console.error("Jev failed", e);
    return null;
  }
}

/** Rate the viewer against every candidate (one request at a time: fetch is synchronous here). */
export function jevFits(http: HttpClient, env: JevEnv, viewer: Profile, candidates: Profile[]) {
  const out = new Map<string, JevFit>();
  for (const c of candidates) {
    const fit = jevPairFit(http, env, viewer, c);
    if (fit) out.set(c.id, fit);
  }
  return out;
}
