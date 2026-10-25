import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Data model.
 *
 * The phone number is the account. Every profile field is optional so people
 * can fill them in the app or let the text agent collect them over time.
 *
 * Pairs of people are stored either as a canonical pair (a < b, see lib/pairs)
 * when the fact is symmetric (distance, a conversation) or as directed rows
 * (viewer -> other) when each side sees something different (match scores,
 * saved contacts, timeline).
 */
export default defineSchema({
  users: defineTable({
    phone: v.string(),
    password: v.optional(v.string()), // demo only, plain text, optional
    name: v.optional(v.string()),
    headline: v.optional(v.string()), // role or title, e.g. "Brand marketer"
    company: v.optional(v.string()),
    location: v.optional(v.string()), // e.g. "Vancouver, BC"
    tags: v.optional(v.array(v.string())), // badge tags: role, who you are, what you know
    lookingFor: v.optional(v.string()), // who I want to meet
    offers: v.optional(v.string()), // what I can help with
    hobbies: v.optional(v.array(v.string())),
    appearance: v.optional(v.string()), // for "who to look for" texts
    californiaMode: v.optional(v.boolean()),
    recordConversations: v.optional(v.boolean()),
    lastSeenAt: v.optional(v.number()), // last time the app reported in
    profileUpdatedAt: v.optional(v.number()), // debounces re-scoring

    // How the badge looks (see lib/avatar.ts)
    avatarShape: v.optional(v.string()), // blob | puzzle | circle | triangle | square | pill | flower
    avatarColor: v.optional(v.string()), // "#RRGGBB"
    badgeLayout: v.optional(v.string()), // avatar | photo | photoText
    photoId: v.optional(v.id("_storage")),

    // Semantic retrieval (optional, only with VOYAGE_API_KEY, see lib/embeddings.ts)
    seekEmbedding: v.optional(v.array(v.float64())), // who I want to meet
    aboutEmbedding: v.optional(v.array(v.float64())), // who I am and what I offer
  })
    .index("by_phone", ["phone"])
    .vectorIndex("by_about", { vectorField: "aboutEmbedding", dimensions: 1024 })
    .vectorIndex("by_seek", { vectorField: "seekEmbedding", dimensions: 1024 }),

  // Photos on a profile ("moments"), shown with hobbies in the Interests block
  moments: defineTable({
    owner: v.id("users"),
    photoId: v.id("_storage"),
    caption: v.optional(v.string()),
    at: v.number(),
  }).index("by_owner", ["owner", "at"]),

  // Nearby Interaction discovery tokens. Every NISession has its own token, so a
  // phone makes one session per peer and publishes that session's token for them.
  nearbyTokens: defineTable({
    userId: v.id("users"), // owner of the session
    peerId: v.id("users"), // the peer this session is for
    token: v.string(), // base64 of the archived NIDiscoveryToken
    updatedAt: v.number(),
  }).index("by_owner_peer", ["userId", "peerId"]),

  // Latest UWB distance per canonical pair
  proximity: defineTable({
    a: v.id("users"),
    b: v.id("users"),
    meters: v.number(),
    at: v.number(),
    closeSince: v.optional(v.number()), // set while within talking distance
    minMeters: v.number(), // closest they ever got (for "passed by" intros)
  })
    .index("by_pair", ["a", "b"])
    .index("by_a", ["a"])
    .index("by_b", ["b"]),

  // Directed match rows: how much `viewer` would like to meet `other`
  matches: defineTable({
    viewer: v.id("users"),
    other: v.id("users"),
    score: v.number(), // 0..1, already reciprocal (both sides must want it)
    tag: v.optional(v.string()), // the tag of `other` that `viewer` cares about most
    reason: v.optional(v.string()), // one line "why you'd click"
    updatedAt: v.number(),
  })
    .index("by_viewer", ["viewer", "score"])
    .index("by_pair", ["viewer", "other"]),

  // Live conversation between a canonical pair
  conversations: defineTable({
    a: v.id("users"),
    b: v.id("users"),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    topics: v.optional(v.array(v.string())),
    followUpForA: v.optional(v.string()),
    followUpForB: v.optional(v.string()),
  })
    .index("by_pair", ["a", "b"])
    .index("by_a", ["a"])
    .index("by_b", ["b"]),

  // Saved contacts (directed: owner saved other). This is the People list.
  connections: defineTable({
    owner: v.id("users"),
    other: v.id("users"),
    at: v.number(),
  })
    .index("by_owner", ["owner", "at"])
    .index("by_pair", ["owner", "other"]),

  // Timeline entries shown in the People detail view
  activity: defineTable({
    owner: v.id("users"),
    other: v.optional(v.id("users")),
    kind: v.string(),
    text: v.string(),
    at: v.number(),
  })
    .index("by_owner", ["owner", "at"])
    .index("by_owner_other", ["owner", "other", "at"]),

  // What the agent has already told someone about someone (throttling)
  notifications: defineTable({
    owner: v.id("users"),
    other: v.id("users"),
    kind: v.string(), // "headsup" | "intro"
    at: v.number(),
  })
    .index("by_owner", ["owner", "at"])
    .index("by_owner_other", ["owner", "other"]),

  feedback: defineTable({
    owner: v.id("users"),
    other: v.optional(v.id("users")),
    rating: v.optional(v.number()),
    note: v.string(),
    at: v.number(),
  }).index("by_owner", ["owner"]),

  // Matching rubric. One row named "global"; the agent can rewrite `notes`.
  rubric: defineTable({
    name: v.string(),
    needWeight: v.number(),
    valuesWeight: v.number(),
    threshold: v.number(),
    notes: v.string(),
  }).index("by_name", ["name"]),

  // Texts for the agent worker to send. The worker subscribes to unsent rows.
  outbox: defineTable({
    phone: v.string(),
    body: v.string(),
    at: v.number(),
    sentAt: v.optional(v.number()),
  }).index("by_unsent", ["sentAt", "at"]),
});
