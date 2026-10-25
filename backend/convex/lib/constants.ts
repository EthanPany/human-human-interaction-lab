// Tuning knobs in one place.

/** A distance report older than this is treated as "not nearby anymore". */
export const PROXIMITY_FRESH_MS = 20_000;

/** A match starts to show at this distance (UWB senses roughly 10 m line of sight)... */
export const GLOW_RANGE_M = 10;

/** ...and is at full strength from this distance in. */
export const FULL_GLOW_M = 3;

/** Range only with phones whose app checked in this recently (heartbeat is 30 s). */
export const NEARBY_ACTIVE_MS = 3 * 60 * 1000;

/** Within this distance two people count as talking. */
export const TALK_DISTANCE_M = 1.5;

/** How long they must stay that close before we call it a conversation. */
export const TALK_AFTER_MS = 10_000;

/** Someone is "at the event" if their app reported in this recently. */
export const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** At most one heads up text per person in this window. */
export const HEADSUP_COOLDOWN_MS = 10 * 60 * 1000;

/** Default rubric when none is stored yet. */
export const DEFAULT_RUBRIC = {
  needWeight: 0.75,
  valuesWeight: 0.25,
  threshold: 0.45,
  notes:
    "Prioritize people who can directly help with what the viewer is looking for, " +
    "and who would also want to meet the viewer. Shared values and energy matter " +
    "more than identical hobbies.",
};

/** Badge colors. Both people in a match get the same one. */
export const MATCH_COLORS = [
  "#FF7A59",
  "#FFD60A",
  "#8FD3F8",
  "#C6F432",
  "#C9A7F0",
  "#FF8FB8",
];

/** With embeddings on, Claude scores at most this many candidates per viewer. */
export const MAX_SCORED_CANDIDATES = 24;

/** Wait this long after a profile edit before re-scoring (edits come in bursts). */
export const RESCORE_DEBOUNCE_MS = 4_000;

/** The cron ends a conversation this long after it started if the pair drifted apart. */
export const STALE_CONVERSATION_MS = 60_000;
