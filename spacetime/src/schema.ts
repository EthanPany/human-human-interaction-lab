import { schema, table, t, type InferSchema, type ReducerCtx } from "spacetimedb/server";
import { sharingTables } from "./sharingTables";
import { groupTables } from "./groupTables";

/**
 * Data model, mirroring backend/convex/schema.ts.
 *
 * Every table is private: clients never subscribe to rows directly. The iOS
 * app talks to the HTTP routes in http.ts, which run the same logic as the
 * Convex functions inside a transaction and return the same JSON shapes.
 *
 * Ids are strings (UUIDs), so canonical pairs (a < b) and JSON stay the same
 * as on Convex. Times are milliseconds since the epoch, stored as f64.
 */

const users = table(
  { name: "users" },
  {
    id: t.string().primaryKey(),
    phone: t.string().unique(),
    password: t.string().optional(), // demo only, plain text, optional
    name: t.string().optional(),
    headline: t.string().optional(),
    company: t.string().optional(),
    location: t.string().optional(),
    tags: t.array(t.string()).optional(),
    lookingFor: t.string().optional(),
    offers: t.string().optional(),
    hobbies: t.array(t.string()).optional(),
    appearance: t.string().optional(),
    californiaMode: t.bool().optional(),
    recordConversations: t.bool().optional(),
    lastSeenAt: t.f64().optional(),
    profileUpdatedAt: t.f64().optional(),
    avatarShape: t.string().optional(),
    avatarColor: t.string().optional(),
    badgeLayout: t.string().optional(),
    photoId: t.string().optional(),
  },
);

/** Photo bytes (badge photos and moments). Served by GET /photo?id=... */
const photos = table(
  { name: "photos" },
  {
    id: t.string().primaryKey(),
    contentType: t.string(),
    data: t.byteArray(),
    at: t.f64(),
  },
);

const moments = table(
  { name: "moments" },
  {
    id: t.string().primaryKey(),
    owner: t.string().index("btree"),
    photoId: t.string(),
    caption: t.string().optional(),
    at: t.f64(),
  },
);

const nearbyTokens = table(
  { name: "nearby_tokens" },
  {
    id: t.string().primaryKey(),
    userId: t.string().index("btree"),
    peerId: t.string().index("btree"),
    token: t.string(),
    updatedAt: t.f64(),
  },
);

/** Badges worn full screen right now (UWB on). Missing row = not ranging. */
const ranging = table(
  { name: "ranging" },
  {
    userId: t.string().primaryKey(),
    since: t.f64(),
  },
);

const proximity = table(
  { name: "proximity" },
  {
    id: t.string().primaryKey(), // `${a}|${b}`
    a: t.string().index("btree"),
    b: t.string().index("btree"),
    meters: t.f64(),
    at: t.f64(),
    closeSince: t.f64().optional(),
    minMeters: t.f64(),
  },
);

/**
 * Each phone's own latest UWB reading of a peer (directed: userId|peerId).
 * Both directions are merged into the pair's proximity row (nearby.ts).
 */
const pairReadings = table(
  { name: "pair_readings" },
  {
    id: t.string().primaryKey(),
    userId: t.string().index("btree"),
    peerId: t.string().index("btree"),
    meters: t.f64(),
    at: t.f64(),
  },
);

/** Rotating short Bluetooth ids badges advertise (never the user id). */
const bleIds = table(
  { name: "ble_ids" },
  {
    id: t.string().primaryKey(),
    userId: t.string().index("btree"),
    issuedAt: t.f64(),
    expiresAt: t.f64(),
  },
);

/** The latest Bluetooth signal strength a badge heard from another (directed: observer|seen). */
const bleSightings = table(
  { name: "ble_sightings" },
  {
    id: t.string().primaryKey(),
    observer: t.string().index("btree"),
    seen: t.string().index("btree"),
    rssi: t.f64(),
    at: t.f64(),
  },
);

const matches = table(
  { name: "matches" },
  {
    id: t.string().primaryKey(), // `${viewer}|${other}`
    viewer: t.string().index("btree"),
    other: t.string().index("btree"),
    score: t.f64(),
    tag: t.string().optional(),
    reason: t.string().optional(),
    updatedAt: t.f64(),
  },
);

const conversations = table(
  { name: "conversations" },
  {
    id: t.string().primaryKey(),
    pair: t.string().index("btree"), // `${a}|${b}`
    a: t.string().index("btree"),
    b: t.string().index("btree"),
    startedAt: t.f64(),
    endedAt: t.f64().optional(),
    transcript: t.string().optional(),
    summary: t.string().optional(),
    topics: t.array(t.string()).optional(),
    followUpForA: t.string().optional(),
    followUpForB: t.string().optional(),
  },
);

/**
 * Per conversation bookkeeping for encounters (one row per conversations row).
 * A conversation is one encounter: parting and coming back together within
 * REJOIN_WINDOW_MS reopens it, so it can have several together segments.
 * New table instead of new columns on conversations (additive migration).
 */
const encounters = table(
  { name: "encounters" },
  {
    conversationId: t.string().primaryKey(),
    /** A matched pair (tint and approach cues) or two people who just stood together. */
    matched: t.bool(),
    /** Start of the current together segment. */
    segmentStartedAt: t.f64(),
    /** Time together in segments that already ended. */
    activeMs: t.f64(),
    /** Transcript of the segments that already ended (the current one appends to it). */
    priorTranscript: t.string().optional(),
    /** The longest transcript a phone sent for the current segment. */
    segmentTranscript: t.string().optional(),
    /** People whose "Drop short encounters" hid this one (too short). Both: no record at all. */
    hiddenFor: t.array(t.string()),
  },
);

/** California mode consent: one row per person per conversation (`${conversationId}|${userId}`). */
const recordingConsents = table(
  { name: "recording_consents" },
  {
    id: t.string().primaryKey(),
    conversationId: t.string().index("btree"),
    userId: t.string(),
    agree: t.bool(),
    at: t.f64(),
  },
);

/** Per person settings that are not profile fields (users:me returns them, users:updateProfile sets them). */
const userPrefs = table(
  { name: "user_prefs" },
  {
    userId: t.string().primaryKey(),
    /** Where my badge starts responding, meters. Missing: the maximum range. */
    respondFromM: t.f64().optional(),
    /** Missing: on. */
    dropShortEncounters: t.bool().optional(),
  },
);

/** Pairs whose phones range with extended UWB right now (canonical pair key). */
const extendedPairs = table(
  { name: "extended_pairs" },
  {
    id: t.string().primaryKey(),
    at: t.f64(),
  },
);

/** First time a matched pair came within talking distance (canonical pair). */
const meetings = table(
  { name: "meetings" },
  {
    id: t.string().primaryKey(), // `${a}|${b}`
    a: t.string().index("btree"),
    b: t.string().index("btree"),
    firstAt: t.f64(),
    lastAt: t.f64(),
  },
);

const connections = table(
  { name: "connections" },
  {
    id: t.string().primaryKey(), // `${owner}|${other}`
    owner: t.string().index("btree"),
    other: t.string(),
    at: t.f64(),
  },
);

const activity = table(
  { name: "activity" },
  {
    id: t.string().primaryKey(),
    owner: t.string().index("btree"),
    other: t.string().optional(),
    kind: t.string(),
    text: t.string(),
    at: t.f64(),
  },
);

const notifications = table(
  { name: "notifications" },
  {
    id: t.string().primaryKey(),
    owner: t.string().index("btree"),
    other: t.string(),
    kind: t.string(), // "headsup" | "intro"
    at: t.f64(),
  },
);

const feedback = table(
  { name: "feedback" },
  {
    id: t.string().primaryKey(),
    owner: t.string(),
    other: t.string().optional(),
    rating: t.f64().optional(),
    note: t.string(),
    at: t.f64(),
  },
);

const rubric = table(
  { name: "rubric" },
  {
    name: t.string().primaryKey(), // one row: "global"
    needWeight: t.f64(),
    valuesWeight: t.f64(),
    threshold: t.f64(),
    notes: t.string(),
  },
);

const outbox = table(
  { name: "outbox" },
  {
    id: t.string().primaryKey(),
    phone: t.string(),
    body: t.string(),
    at: t.f64(),
    sent: t.bool().index("btree"),
    sentAt: t.f64().optional(),
    attempts: t.u32(),
    failed: t.string().optional(),
  },
);

// Cloud text agent state (see api/cloudAgent.ts)
const photonConversations = table(
  { name: "photon_conversations" },
  {
    phone: t.string().primaryKey(),
    spaceId: t.string(),
    agentUserId: t.string(),
    updatedAt: t.f64(),
  },
);

const agentHistory = table(
  { name: "agent_history" },
  {
    phone: t.string().primaryKey(),
    turns: t.string(),
    updatedAt: t.f64(),
  },
);

const agentCursor = table(
  { name: "agent_cursor" },
  {
    key: t.string().primaryKey(),
    since: t.string(),
    seen: t.array(t.string()),
    lockedUntil: t.f64(),
  },
);

/**
 * Each person's Photon iMessage line (Convex users.agentLine), keyed by their
 * phone. Assigned on sign in by api/photonAssign.ts.
 */
const agentLines = table(
  { name: "agent_lines" },
  {
    phone: t.string().primaryKey(),
    line: t.string(),
    updatedAt: t.f64(),
  },
);

/** Outbox rows that are the sign up welcome (Convex outbox.kind === "welcome"). */
const welcomeTexts = table(
  { name: "welcome_texts" },
  {
    outboxId: t.string().primaryKey(),
    phone: t.string().index("btree"),
  },
);

/**
 * Every inbound iMessage, stored once by its Photon message id, so a repeated
 * fetch or an overlapping tick can never answer the same text twice.
 */
const agentInbox = table(
  { name: "agent_inbox" },
  {
    id: t.string().primaryKey(), // Photon message id
    phone: t.string().index("btree"),
    text: t.string().optional(),
    createdAt: t.string(), // Photon ISO time
    receivedAt: t.f64(),
    spaceId: t.string(),
    agentUserId: t.string(),
    turnId: t.string().optional(), // set once the message belongs to a turn
  },
);

/** One reply per inbound turn (a burst of texts), keyed by the burst's last message id. */
const agentTurns = table(
  { name: "agent_turns" },
  {
    id: t.string().primaryKey(),
    phone: t.string().index("btree"),
    claim: t.string(), // who is working on it right now
    claimedUntil: t.f64(),
    reply: t.string().optional(), // stored before sending, so a retry resends the same text
    sentAt: t.f64().optional(),
    attempts: t.u32(),
    failed: t.string().optional(),
    at: t.f64(),
  },
);

/** Per person pacing for the agent's texts (keyed by normalized phone). */
const agentPace = table(
  { name: "agent_pace" },
  {
    phone: t.string().primaryKey(),
    lastInAt: t.f64(),
    lastOutAt: t.f64(),
    lastUnsolicitedAt: t.f64(),
    cardAt: t.f64().optional(),
  },
);

/** What an outbox row is for (heads up, follow up, recap), and when it may go out. */
const outboxMeta = table(
  { name: "outbox_meta" },
  {
    outboxId: t.string().primaryKey(),
    kind: t.string(),
    conversationId: t.string().optional(),
    holdUntil: t.f64().optional(),
    expiresAt: t.f64().optional(),
  },
);

/** Approximate phone location (about 100 m grid), only while the app is open. Expires after 15 minutes. */
const coarseLocations = table(
  { name: "coarse_locations" },
  {
    userId: t.string().primaryKey(),
    lat: t.f64(),
    lng: t.f64(),
    accuracy: t.f64(),
    at: t.f64(),
  },
);

// Schedule tables (Convex crons and ctx.scheduler.runAfter) ----------------

/** Every minute: heads up texts and closing stale conversations. */
export const minuteJob = table(
  { name: "minute_job" },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() },
);

/** Every 5 seconds: the Photon text agent. */
export const agentJob = table(
  { name: "agent_job" },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() },
);

/** One shot: summarize a finished conversation with Claude. */
export const summarizeJob = table(
  { name: "summarize_job" },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), conversationId: t.string() },
);

/** One shot: re-score a person after a profile edit (debounced). */
export const rescoreJob = table(
  { name: "rescore_job" },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    userId: t.string(),
    requestedAt: t.f64(),
  },
);

/** One shot: re-score everyone (seed, rubric change). */
export const rescoreAllJob = table(
  { name: "rescore_all_job" },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() },
);

/** One shot: check a person's Photon line (photonAssign:ensure), on every sign in and in the backfill. */
export const photonAssignJob = table(
  { name: "photon_assign_job" },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), userId: t.string() },
);

const spacetimedb = schema(
  {
    users,
    photos,
    moments,
    nearbyTokens,
    ranging,
    proximity,
    pairReadings,
    bleIds,
    bleSightings,
    matches,
    conversations,
    encounters,
    recordingConsents,
    userPrefs,
    extendedPairs,
    meetings,
    connections,
    activity,
    notifications,
    feedback,
    rubric,
    outbox,
    photonConversations,
    agentHistory,
    agentCursor,
    agentLines,
    welcomeTexts,
    agentInbox,
    agentTurns,
    agentPace,
    outboxMeta,
    coarseLocations,
    minuteJob,
    agentJob,
    summarizeJob,
    rescoreJob,
    rescoreAllJob,
    photonAssignJob,
    // Contact sharing and profile photos (sharingTables.ts)
    ...sharingTables,
    // Group encounters, three or more together (groupTables.ts)
    ...groupTables,
  },
  {
    // Secrets and settings, set with `spacetime publish` (see README).
    env: {
      ANTHROPIC_API_KEY: t.string().optional(),
      CLAUDE_MODEL: t.string().optional(),
      PHOTON_API_KEY: t.string().optional(),
      PHOTON_PROJECT_ID: t.string().optional(),
      /** TypeSafe Jev pair scoring (lib/jev.ts). Without it Claude scores alone. */
      TYPESAFE_API_KEY: t.string().optional(),
      /** Defaults to jev-latest. */
      JEV_MODEL: t.string().optional(),
      /** e.g. https://maincloud.spacetimedb.com; photo links are built from it. */
      PUBLIC_BASE_URL: t.string().optional(),
    },
  },
);

export default spacetimedb;

export type S = InferSchema<typeof spacetimedb>;
/** A transaction: reducers and `withTx` bodies. */
export type Tx = ReducerCtx<S>;
export type User = NonNullable<ReturnType<Tx["db"]["users"]["id"]["find"]>>;
export type Conversation = NonNullable<ReturnType<Tx["db"]["conversations"]["id"]["find"]>>;
export type Encounter = NonNullable<ReturnType<Tx["db"]["encounters"]["conversationId"]["find"]>>;
export type EncounterMember = NonNullable<ReturnType<Tx["db"]["encounterMembers"]["id"]["find"]>>;
