import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { agentReply, type AgentHost, type Turn } from "./lib/agentCore";
import { normalizeHandle, PhotonError, photonConfigured, receivedSince, sendText } from "./lib/photonApi";
import { normalizePhone } from "./lib/phone";

/**
 * The text agent, hosted in Convex. A cron calls `tick` every few seconds:
 *   1. read new iMessages from Photon and answer each with Claude,
 *   2. send queued texts (heads ups, "save their contact?", recaps).
 * Turned on by setting PHOTON_API_KEY and PHOTON_PROJECT_ID in the Convex env;
 * then nothing has to run on a laptop. Photon's shared line only lets the agent
 * text people who have texted it since being added to the line.
 */

const LEASE_MS = 90_000;
const MAX_SEND_ATTEMPTS = 30; // about 2.5 minutes of retries at the 5 s tick
const KEY = "photon";

export const status = query({
  args: {},
  handler: async () => ({ enabled: photonConfigured() }),
});

// MARK: Lease and cursor

export const acquire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const row = await ctx.db.query("agentCursor").withIndex("by_key", (q) => q.eq("key", KEY)).unique();
    if (row && row.lockedUntil > now) return null; // another tick is running
    if (!row) {
      // Start from now: don't answer texts sent before the agent existed.
      const since = new Date(now).toISOString();
      await ctx.db.insert("agentCursor", { key: KEY, since, seen: [], lockedUntil: now + LEASE_MS });
      return { since, seen: [] as string[] };
    }
    await ctx.db.patch(row._id, { lockedUntil: now + LEASE_MS });
    return { since: row.since, seen: row.seen };
  },
});

export const release = internalMutation({
  args: { since: v.string(), seen: v.array(v.string()) },
  handler: async (ctx, { since, seen }) => {
    const row = await ctx.db.query("agentCursor").withIndex("by_key", (q) => q.eq("key", KEY)).unique();
    if (row) await ctx.db.patch(row._id, { since, seen: seen.slice(-300), lockedUntil: 0 });
  },
});

// MARK: Conversations and history

export const rememberConversation = internalMutation({
  args: { phone: v.string(), spaceId: v.string(), agentUserId: v.string() },
  handler: async (ctx, { phone, spaceId, agentUserId }) => {
    const key = normalizeHandle(phone);
    const row = await ctx.db.query("photonConversations").withIndex("by_phone", (q) => q.eq("phone", key)).unique();
    if (row) await ctx.db.patch(row._id, { spaceId, agentUserId, updatedAt: Date.now() });
    else await ctx.db.insert("photonConversations", { phone: key, spaceId, agentUserId, updatedAt: Date.now() });
  },
});

export const conversationFor = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) =>
    await ctx.db
      .query("photonConversations")
      .withIndex("by_phone", (q) => q.eq("phone", normalizeHandle(phone)))
      .unique(),
});

export const loadHistory = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const row = await ctx.db.query("agentHistory").withIndex("by_phone", (q) => q.eq("phone", phone)).unique();
    return row ? (JSON.parse(row.turns) as Turn[]) : [];
  },
});

export const saveHistory = internalMutation({
  args: { phone: v.string(), turns: v.string() },
  handler: async (ctx, { phone, turns }) => {
    const row = await ctx.db.query("agentHistory").withIndex("by_phone", (q) => q.eq("phone", phone)).unique();
    if (row) await ctx.db.patch(row._id, { turns, updatedAt: Date.now() });
    else await ctx.db.insert("agentHistory", { phone, turns, updatedAt: Date.now() });
  },
});

// MARK: Outbox

export const pendingTexts = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db.query("outbox").withIndex("by_unsent", (q) => q.eq("sentAt", undefined)).take(50),
});

export const markText = internalMutation({
  args: { id: v.id("outbox"), sent: v.boolean(), failed: v.optional(v.string()) },
  handler: async (ctx, { id, sent, failed }) => {
    const row = await ctx.db.get(id);
    if (!row) return;
    if (sent) return await ctx.db.patch(id, { sentAt: Date.now() });
    const attempts = (row.attempts ?? 0) + 1;
    if (attempts >= MAX_SEND_ATTEMPTS) {
      await ctx.db.patch(id, { attempts, sentAt: Date.now(), failed: failed ?? "gave up" });
    } else {
      await ctx.db.patch(id, { attempts });
    }
  },
});

// MARK: The tick

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!photonConfigured() || !process.env.ANTHROPIC_API_KEY) return;
    const lease = await ctx.runMutation(internal.cloudAgent.acquire, {});
    if (!lease) return;

    let { since } = lease;
    const seen = new Set(lease.seen);
    try {
      // 1. Answer new texts
      const inbound = await receivedSince(since);
      for (const m of inbound) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (m.createdAt > since) since = m.createdAt;
        const phone = normalizePhone(m.from);
        await ctx.runMutation(internal.cloudAgent.rememberConversation, {
          phone,
          spaceId: m.spaceId,
          agentUserId: m.agentUserId,
        });
        if (!m.text) continue;
        console.log(`[${phone}] ${m.text}`);
        let reply: string;
        try {
          const host: AgentHost = {
            context: (p) => ctx.runQuery(api.agent.context, { phone: p }),
            ensureUser: (p) => ctx.runMutation(api.agent.ensureUser, { phone: p }),
            saveProfile: (p, patch) => ctx.runMutation(api.agent.saveProfile, { phone: p, patch }),
            confirmContact: (p) => ctx.runMutation(api.agent.confirmContact, { phone: p }),
            addFeedback: (p, note, rating, otherName) =>
              ctx.runMutation(api.agent.addFeedback, { phone: p, note, rating, otherName }),
            updateRubricNotes: (notes) => ctx.runMutation(api.agent.updateRubricNotes, { notes }),
          };
          const history: Turn[] = await ctx.runQuery(internal.cloudAgent.loadHistory, { phone });
          const result = await agentReply({
            host,
            apiKey: process.env.ANTHROPIC_API_KEY!,
            model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
            phone,
            text: m.text,
            history,
          });
          await ctx.runMutation(internal.cloudAgent.saveHistory, { phone, turns: JSON.stringify(result.history) });
          reply = result.reply;
        } catch (e) {
          console.error("agent reply failed", e);
          reply = "Sorry, I hit a snag. Try again in a moment?";
        }
        await sendText(m.spaceId, m.agentUserId, reply, `reply:${m.id}`);
        console.log(`[agent -> ${phone}] ${reply}`);
      }

      // 2. Send queued texts
      const pending = await ctx.runQuery(internal.cloudAgent.pendingTexts, {});
      for (const t of pending) {
        const convo = await ctx.runQuery(internal.cloudAgent.conversationFor, { phone: t.phone });
        if (!convo) {
          await ctx.runMutation(internal.cloudAgent.markText, {
            id: t._id,
            sent: false,
            failed: "no conversation yet: they need to text the agent first",
          });
          continue;
        }
        try {
          await sendText(convo.spaceId, convo.agentUserId, t.body, `outbox:${t._id}`);
          await ctx.runMutation(internal.cloudAgent.markText, { id: t._id, sent: true });
        } catch (e) {
          const reason = e instanceof PhotonError ? e.message : String(e);
          console.error(`send to ${t.phone} failed`, reason);
          await ctx.runMutation(internal.cloudAgent.markText, { id: t._id, sent: false, failed: reason });
        }
      }
    } finally {
      await ctx.runMutation(internal.cloudAgent.release, { since, seen: [...seen] });
    }
  },
});
