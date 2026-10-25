import { schema, table, t, type InferSchema, type ReducerCtx } from "spacetimedb/server";

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

const spacetimedb = schema(
  {
    users,
    photos,
    moments,
    nearbyTokens,
    proximity,
    matches,
    conversations,
    connections,
    activity,
    notifications,
    feedback,
    rubric,
    outbox,
    photonConversations,
    agentHistory,
    agentCursor,
    minuteJob,
    agentJob,
    summarizeJob,
    rescoreJob,
    rescoreAllJob,
  },
  {
    // Secrets and settings, set with `spacetime publish` (see README).
    env: {
      ANTHROPIC_API_KEY: t.string().optional(),
      CLAUDE_MODEL: t.string().optional(),
      PHOTON_API_KEY: t.string().optional(),
      PHOTON_PROJECT_ID: t.string().optional(),
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
