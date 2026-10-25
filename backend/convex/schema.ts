import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // The phone number is the account. Every profile field is optional so
  // people can fill them in the app or let the agent collect them by text.
  users: defineTable({
    phone: v.string(),
    password: v.optional(v.string()), // demo only, plain text
    name: v.optional(v.string()),
    headline: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    lookingFor: v.optional(v.string()),
    hobbies: v.optional(v.array(v.string())),
    appearance: v.optional(v.string()), // used in "who to look for" texts
    californiaMode: v.optional(v.boolean()),
  }).index("by_phone", ["phone"]),

  // NearbyInteraction discovery tokens, base64 encoded
  tokens: defineTable({
    userId: v.id("users"),
    token: v.string(),
  }).index("by_user", ["userId"]),

  proximity: defineTable({
    a: v.id("users"),
    b: v.id("users"),
    meters: v.number(),
    at: v.number(),
  }).index("by_pair", ["a", "b"]),

  matches: defineTable({
    a: v.id("users"),
    b: v.id("users"),
    score: v.number(),
    tagForA: v.optional(v.string()), // the tag of B that A cares about most
    tagForB: v.optional(v.string()),
  }).index("by_pair", ["a", "b"]),

  connections: defineTable({
    a: v.id("users"),
    b: v.id("users"),
    at: v.number(),
  }).index("by_a", ["a"]),

  conversations: defineTable({
    a: v.id("users"),
    b: v.id("users"),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    at: v.number(),
  }).index("by_a", ["a"]),

  // Texts the agent worker should send. The worker subscribes to unsent rows.
  outbox: defineTable({
    phone: v.string(),
    body: v.string(),
    sentAt: v.optional(v.number()),
  }).index("by_unsent", ["sentAt"]),
});
