import { mutation, query, internalQuery, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { normalizePhone, isValidPhone } from "./lib/phone";
import { queueText } from "./lib/texts";
import { normalizeHandle } from "./lib/photonApi";
import { avatarOf, defaultAvatar } from "./lib/avatar";
import { requestRescore } from "./lib/rescore";

/** Profile fields the app and the agent are allowed to edit. */
export const profilePatch = v.object({
  name: v.optional(v.string()),
  headline: v.optional(v.string()),
  company: v.optional(v.string()),
  location: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  lookingFor: v.optional(v.string()),
  offers: v.optional(v.string()),
  hobbies: v.optional(v.array(v.string())),
  appearance: v.optional(v.string()),
  californiaMode: v.optional(v.boolean()),
  recordConversations: v.optional(v.boolean()),
  avatarShape: v.optional(v.string()),
  avatarColor: v.optional(v.string()),
  badgeLayout: v.optional(v.string()),
});

/** Fields that change who someone matches with. Editing others skips re-scoring. */
const MATCHING_FIELDS = ["name", "headline", "company", "tags", "lookingFor", "offers", "hobbies"] as const;

export function touchesMatching(patch: Record<string, unknown>) {
  return MATCHING_FIELDS.some((k) => patch[k] !== undefined);
}

/** The signed in person's own view of their profile (no password, no vectors). */
async function ownProfile(ctx: QueryCtx, u: Doc<"users">) {
  const { password, seekEmbedding, aboutEmbedding, photoId, ...rest } = u;
  const avatar = avatarOf(u);
  return {
    ...rest,
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    badgeLayout: u.badgeLayout ?? "avatar",
    photoUrl: photoId ? await ctx.storage.getUrl(photoId) : null,
    hasPassword: Boolean(password),
    // Our own SMS number (SMS_LINE) or one shared line (AGENT_LINE): everyone texts that number.
    agentLine: process.env.SMS_LINE || process.env.AGENT_LINE || u.agentLine,
    // False until they text their agent line once. The app should then say
    // "Text your agent to start" (a shared iMessage line can't text first).
    agentConnected: Boolean(process.env.SMS_LINE) || Boolean(process.env.AGENT_LINE) || process.env.AGENT_MODE === "spectrum" || Boolean(
      await ctx.db
        .query("photonConversations")
        .withIndex("by_phone", (q) => q.eq("phone", normalizeHandle(u.phone)))
        .first(),
    ),
  };
}

/** Sign up or sign in with a phone number. Password is optional for the demo. */
export const signIn = mutation({
  args: { phone: v.string(), name: v.optional(v.string()), password: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const phone = normalizePhone(args.phone);
    if (!isValidPhone(phone)) throw new Error("Enter a full phone number, with the country code if outside the US");
    const existing = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .unique();
    if (existing) {
      if (existing.password && existing.password !== args.password) {
        throw new Error("Wrong password");
      }
      if (args.name && !existing.name) await ctx.db.patch(existing._id, { name: args.name });
      // Every sign in checks their Photon line (adds them if missing, fixes a stale one)
      await ctx.scheduler.runAfter(0, internal.photonAssign.ensure, { userId: existing._id });
      return existing._id;
    }
    const id = await ctx.db.insert("users", {
      phone,
      name: args.name,
      password: args.password || undefined,
      californiaMode: false,
      recordConversations: true,
      lastSeenAt: Date.now(),
      badgeLayout: "avatar",
      ...defaultAvatar(phone),
    });
    // Put them on the iMessage line right away so texting the agent just works
    await ctx.scheduler.runAfter(0, internal.photonAssign.ensure, { userId: id });
    // Sent as soon as they first text the line (a shared line can't text first).
    // If their first text gets a direct answer, the agent greets them there instead.
    await queueText(
      ctx,
      phone,
      args.name
        ? `Hi ${args.name}, I'm your badge agent. I'll help you meet the right people at the event and remember who you met. Quick question to get you set up: what do you do?`
        : "Hi, I'm your badge agent. I'll help you meet the right people at the event and remember who you met. What should I call you?",
      "welcome",
    );
    return id;
  },
});

export const me = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const u = await ctx.db.get(userId);
    return u ? await ownProfile(ctx, u) : null;
  },
});

export const updateProfile = mutation({
  args: { userId: v.id("users"), patch: profilePatch },
  handler: async (ctx, { userId, patch }) => {
    await ctx.db.patch(userId, patch);
    if (touchesMatching(patch)) await requestRescore(ctx, userId);
  },
});

/** The app calls this every 30 seconds while open: "I'm at the event". */
export const heartbeat = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await ctx.db.patch(userId, { lastSeenAt: Date.now() });
  },
});

// Photos ---------------------------------------------------------------------
// Upload flow: generateUploadUrl -> POST the JPEG -> storageId -> setPhoto/addMoment.

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/** Badge photo. Pass no storageId to remove it. */
export const setPhoto = mutation({
  args: { userId: v.id("users"), storageId: v.optional(v.id("_storage")) },
  handler: async (ctx, { userId, storageId }) => {
    const u = await ctx.db.get(userId);
    if (!u) throw new Error("No such user");
    if (u.photoId && u.photoId !== storageId) await ctx.storage.delete(u.photoId);
    await ctx.db.patch(userId, {
      photoId: storageId,
      badgeLayout: storageId ? (u.badgeLayout === "avatar" ? "photoText" : u.badgeLayout) : "avatar",
    });
  },
});

export const moments = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("moments")
      .withIndex("by_owner", (q) => q.eq("owner", userId))
      .order("desc")
      .take(30);
    return await Promise.all(
      rows.map(async (m) => ({ id: m._id, caption: m.caption, at: m.at, url: await ctx.storage.getUrl(m.photoId) })),
    );
  },
});

export const addMoment = mutation({
  args: { userId: v.id("users"), storageId: v.id("_storage"), caption: v.optional(v.string()) },
  handler: async (ctx, { userId, storageId, caption }) => {
    await ctx.db.insert("moments", { owner: userId, photoId: storageId, caption, at: Date.now() });
  },
});

export const removeMoment = mutation({
  args: { userId: v.id("users"), momentId: v.id("moments") },
  handler: async (ctx, { userId, momentId }) => {
    const m = await ctx.db.get(momentId);
    if (!m || m.owner !== userId) return;
    await ctx.storage.delete(m.photoId);
    await ctx.db.delete(momentId);
  },
});

// Internal -------------------------------------------------------------------

export const byPhone = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", normalizePhone(phone)))
      .unique();
  },
});

export const all = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("users").collect(),
});
