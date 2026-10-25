/**
 * Matching math, kept pure so it is easy to test and to explain.
 *
 * Inspired by Ditto: match on what people need and what they value, not just
 * shared hobbies, and require that BOTH sides would want the intro.
 *
 *   needFit(A <- B)  how well B can help with what A is looking for   (0..1)
 *   needFit(B <- A)  how well A can help with what B is looking for   (0..1)
 *   reciprocal       sqrt(needFitAB * needFitBA)  (geometric mean: one-sided
 *                    interest scores low, like reciprocal recommenders)
 *   values           affinity in values, energy, interests            (0..1)
 *   score            needWeight * reciprocal + valuesWeight * values
 *
 * Claude estimates needFit and values from the profiles (see matching.ts).
 * The keyword fallback below is used when no API key is configured.
 */

export type Profile = {
  id: string;
  name?: string;
  headline?: string;
  company?: string;
  tags?: string[];
  lookingFor?: string;
  offers?: string;
  hobbies?: string[];
};

export type Rubric = { needWeight: number; valuesWeight: number; threshold: number };

export function combine(
  needFitMe: number,
  needFitThem: number,
  values: number,
  rubric: Rubric,
): number {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const reciprocal = Math.sqrt(clamp(needFitMe) * clamp(needFitThem));
  const total = rubric.needWeight + rubric.valuesWeight || 1;
  return clamp((rubric.needWeight * reciprocal + rubric.valuesWeight * clamp(values)) / total);
}

const STOP = new Set([
  "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "who",
  "i", "im", "i'm", "am", "is", "are", "be", "someone", "people", "person",
  "want", "meet", "looking", "like", "my", "me", "at", "about", "into",
]);

/** Tiny stemmer: "founders" -> "founder", "engineering" -> "engineer". */
function stem(w: string): string {
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

export function words(text: string | undefined): Set<string> {
  return new Set(
    (text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map(stem),
  );
}

function overlap(want: Set<string>, have: Set<string>): number {
  if (want.size === 0) return 0.3; // unknown needs: mild default
  let hits = 0;
  for (const w of want) if (have.has(w)) hits++;
  return Math.min(1, hits / Math.min(want.size, 2));
}

function describes(p: Profile): Set<string> {
  return words([p.headline, p.offers, ...(p.tags ?? [])].join(" "));
}

/** Which of `other`'s tags best answers what `viewer` is looking for. */
export function pickTag(viewer: Profile, other: Profile): string | undefined {
  const want = words(viewer.lookingFor);
  const tags = other.tags ?? [];
  const best = tags.find((t) => [...words(t)].some((w) => want.has(w)));
  return best ?? tags[0];
}

/** Deterministic fallback score when Claude is not available. */
export function keywordScore(viewer: Profile, other: Profile, rubric: Rubric) {
  const fitMe = overlap(words(viewer.lookingFor), describes(other));
  const fitThem = overlap(words(other.lookingFor), describes(viewer));
  const hv = new Set((viewer.hobbies ?? []).map((h) => h.toLowerCase()));
  const ho = new Set((other.hobbies ?? []).map((h) => h.toLowerCase()));
  const union = new Set([...hv, ...ho]);
  let shared = 0;
  for (const h of hv) if (ho.has(h)) shared++;
  const values = union.size ? shared / union.size : 0.3;
  return {
    score: combine(fitMe, fitThem, values, rubric),
    tag: pickTag(viewer, other),
    reason: fitMe > 0.5 ? `${other.name ?? "They"} matches what you're looking for.` : undefined,
  };
}
