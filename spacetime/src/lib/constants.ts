// Tuning knobs in one place.

/** A distance report older than this is treated as "not nearby anymore". */
export const PROXIMITY_FRESH_MS = 8_000;

/**
 * Distance rules. The app uses the same numbers (BadgeStore in the iOS app):
 * keep both in step.
 *
 * A badge reacts from the maximum ranging range: standard UWB senses about
 * 9 m, extended UWB (iPhone 15 or later on both phones) about 50 m. Each
 * person can lower where their badge starts responding ("Respond from" in
 * Settings > Nearby, stored in user_prefs). A pair uses the smaller of the two,
 * so both badges start reacting at the same distance.
 */
export const STANDARD_RANGE_M = 9;
export const EXTENDED_RANGE_M = 50;
/** The lowest "Respond from" the app offers. */
export const MIN_RESPOND_FROM_M = 2;

/** Within this distance two people are together (they meet, recording can start). */
export const TALK_DISTANCE_M = 1.0;

/**
 * Once together, they stay together until they are this far apart. Both
 * phones report into the same row and each reading jitters, so without this
 * margin one reading just past the line ended the conversation.
 */
export const TALK_EXIT_DISTANCE_M = 1.5;

/** How long they must stay together before we call it a conversation (and recording starts). */
export const TALK_AFTER_MS = 1_000;

/** Back together within this long after parting: the same encounter continues (same record, recording appends). */
export const REJOIN_WINDOW_MS = 5 * 60 * 1000;

/** "Drop short encounters" (on by default): encounters shorter than this leave no record, summary or text. */
export const MIN_ENCOUNTER_MS = 60 * 1000;

/**
 * Groups (api/groups.ts): three or more people together share one encounter.
 * Everyone within TALK_DISTANCE_M of at least one member, and the group
 * connected, is in it; each person leaves past TALK_EXIT_DISTANCE_M from
 * everyone in it. The app shows up to BADGE_GROUP_SHOWN other avatars.
 */
export const MIN_GROUP_SIZE = 3;
/** Nobody in reach for this long: that person has left the encounter (readings jitter, people shuffle). */
export const GROUP_LEAVE_GRACE_MS = 3_000;
/** The largest group one encounter follows (a crowd standing close stays bounded). */
export const MAX_GROUP_SIZE = 12;
/** Left a group that goes on: their follow up text waits at most this long for the group to end. */
export const LEFT_GROUP_FOLLOW_UP_WAIT_MS = 10 * 60 * 1000;
/** Transcript pieces covering at least this share of the shorter one's time are duplicates (several phones recorded the same talk). */
export const PART_OVERLAP_SHARE = 0.5;

/**
 * Both phones report their own UWB reading of each other (pair_readings), and
 * the pair's distance is merged from both: when both sides read within this
 * long, the smaller one counts (a body or a turned phone only ever makes UWB
 * read too far, or not at all); otherwise the freshest one. One side seeing
 * the other is enough.
 */
export const UWB_MERGE_MS = 1_000;
/** A UWB reading this recent still counts for the pair (before falling back to Bluetooth). */
export const UWB_FRESH_MS = 2_500;

/**
 * Bluetooth assist (nearby:reportBle). Each badge advertises a rotating short
 * id from the server (never the user id) and reports the signal strength
 * (RSSI, dBm) of the badges it hears. It is a coarse signal only: "in the
 * area" (approach cues, waking UWB sessions, slot priority). It decides
 * "together" only when UWB had nothing for the pair for UWB_LOST_FOR_ESTIMATE_MS
 * and the signal is very strong, and then the badge says it is estimated.
 */
export const BLE_FRESH_MS = 6_000;
/** Heard at least this strong: in the area. */
export const BLE_IN_AREA_RSSI = -88;
/** Rough distance from RSSI: this at 1 m, path loss exponent below (a crowd absorbs a lot). */
export const BLE_RSSI_AT_1M = -59;
export const BLE_PATH_LOSS = 2.2;
/** A Bluetooth estimate never says closer than this, unless it is very strong (below). */
export const BLE_MIN_ESTIMATE_M = 2;
/** Very strong: two lanyards about an arm's length apart. */
export const BLE_TOGETHER_RSSI = -50;
/** No UWB reading from either side for this long before Bluetooth may say "together". */
export const UWB_LOST_FOR_ESTIMATE_MS = 4_000;
/** Together already and still this strong: stay together while UWB is briefly blind. */
export const BLE_HOLD_RSSI = -62;
/** Bluetooth estimates further than this don't write a distance (only "in the area"). */
export const BLE_PROXIMITY_MAX_M = 15;
/** A badge's Bluetooth id changes this often; the previous one still resolves for the grace. */
export const BLE_ID_ROTATE_MS = 15 * 60 * 1000;
export const BLE_ID_GRACE_MS = 2 * 60 * 1000;

/** Rough meters from a Bluetooth signal strength (dBm). */
export function bleEstimateM(rssi: number) {
  return Math.max(0.3, Math.min(60, Math.pow(10, (BLE_RSSI_AT_1M - rssi) / (10 * BLE_PATH_LOSS))));
}

/** How strongly a match shows, 0 at the pair's respond range up to 1 at talking distance. */
export function closenessAt(meters: number, rangeM: number) {
  const span = Math.max(0.1, rangeM - TALK_DISTANCE_M);
  return Math.max(0, Math.min(1, (rangeM - meters) / span));
}

/** "You passed by" intros at the end of the event (notify.ts) count people who came within twice this. */
export const GLOW_RANGE_M = 8;

/** Range only with phones whose app checked in this recently (heartbeat is 30 s). */
export const NEARBY_ACTIVE_MS = 3 * 60 * 1000;

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
