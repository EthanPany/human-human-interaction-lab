import { internalAction, internalMutation, internalQuery, query, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { agentReply, type AgentHost, type Turn } from "./lib/agentCore";
import { AGENT_PHOTO_JPEG_BASE64 } from "./lib/agentPhoto";
import { agentVCard, lineFor, sendAttachment, uploadAttachment } from "./lib/photonApi";
import { normalizeHandle, openDirect, PhotonError, photonConfigured, receivedSince, sendText, setTyping, smsLine, type PhotonInbound } from "./lib/photonApi";
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
const MAX_SEND_ATTEMPTS = 30; // about 2.5 minutes of retries at the 5 s tick, once a thread exists
const WAIT_FOR_FIRST_TEXT_MS = 6 * 3600_000; // heads ups and recaps go stale
const WELCOME_WAIT_MS = 7 * 24 * 3600_000;
const KEY = "photon";

/** Health check: `npx convex run cloudAgent:status` */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("agentCursor").withIndex("by_key", (q) => q.eq("key", KEY)).unique();
    const now = Date.now();
    return {
      enabled: photonConfigured(),
      claude: Boolean(process.env.ANTHROPIC_API_KEY),
      since: row?.since,
      secondsSinceLastTick: row?.lastTickAt ? Math.round((now - row.lastTickAt) / 1000) : null,
      lastInboundAt: row?.lastInboundAt ? new Date(row.lastInboundAt).toISOString() : null,
      lastError: row?.lastError ?? null,
      locked: (row?.lockedUntil ?? 0) > now,
    };
  },
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
  args: { since: v.string(), seen: v.array(v.string()), inbound: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { since, seen, inbound, error }) => {
    const row = await ctx.db.query("agentCursor").withIndex("by_key", (q) => q.eq("key", KEY)).unique();
    if (!row) return;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      since,
      seen: seen.slice(-300),
      lockedUntil: 0,
      lastTickAt: now,
      ...(inbound ? { lastInboundAt: now } : {}),
      ...(error !== undefined ? { lastError: `${new Date(now).toISOString()} ${error}` } : {}),
    });
  },
});

/** Their first text ever? Then the reply is the greeting and the queued welcome is dropped. */
export const firstContact = internalMutation({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const history = await ctx.db.query("agentHistory").withIndex("by_phone", (q) => q.eq("phone", phone)).unique();
    const queued = await ctx.db.query("outbox").withIndex("by_phone", (q) => q.eq("phone", phone)).collect();
    for (const t of queued) {
      if (t.kind === "welcome" && t.sentAt === undefined) {
        await ctx.db.patch(t._id, { sentAt: Date.now(), failed: "superseded: greeted in the first reply" });
      }
    }
    return !history;
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
  args: { id: v.id("outbox"), sent: v.boolean(), failed: v.optional(v.string()), waiting: v.optional(v.boolean()) },
  handler: async (ctx, { id, sent, failed, waiting }) => {
    const row = await ctx.db.get(id);
    if (!row) return;
    if (sent) return await ctx.db.patch(id, { sentAt: Date.now() });
    if (waiting) {
      // No thread yet: hold it until they text the line, then it goes out.
      const limit = row.kind === "welcome" ? WELCOME_WAIT_MS : WAIT_FOR_FIRST_TEXT_MS;
      if (Date.now() - row.at > limit) await ctx.db.patch(id, { sentAt: Date.now(), failed: failed ?? "expired" });
      return;
    }
    const attempts = (row.attempts ?? 0) + 1;
    if (attempts >= MAX_SEND_ATTEMPTS) {
      await ctx.db.patch(id, { attempts, sentAt: Date.now(), failed: failed ?? "gave up" });
    } else {
      await ctx.db.patch(id, { attempts });
    }
  },
});

// MARK: The tick

/** Several texts in a row from one person become one turn (people send bursts). */
function groupByPhone(msgs: PhotonInbound[]) {
  const out = new Map<string, { last: PhotonInbound; texts: string[] }>();
  for (const m of msgs) {
    const phone = normalizePhone(m.from);
    const g = out.get(phone) ?? { last: m, texts: [] };
    g.last = m;
    if (m.text?.trim()) g.texts.push(m.text.trim());
    out.set(phone, g);
  }
  return out;
}

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!photonConfigured() || !process.env.ANTHROPIC_API_KEY) return;
    const lease = await ctx.runMutation(internal.cloudAgent.acquire, {});
    if (!lease) return;

    let { since } = lease;
    const seen = new Set(lease.seen);
    let error: string | undefined;
    let inboundCount = 0;
    const note = (e: unknown) => {
      error = e instanceof Error ? e.message : String(e);
    };
    try {
      // 1. Answer new texts
      const inbound = (await receivedSince(since)).filter((m) => !seen.has(m.id));
      for (const m of inbound) {
        seen.add(m.id);
        if (m.createdAt > since) since = m.createdAt;
      }
      inboundCount = inbound.length;
      for (const [phone, { last, texts }] of groupByPhone(inbound)) {
        await ctx.runMutation(internal.cloudAgent.rememberConversation, {
          phone,
          spaceId: last.spaceId,
          agentUserId: last.agentUserId,
        });
        if (texts.length === 0) continue; // an image or tapback only
        const text = texts.join("\n");
        console.log(`[${phone}] ${text}`);
        await setTyping(last.spaceId, last.agentUserId, true);
        let bubbles: string[];
        let first = false;
        try {
          first = await ctx.runMutation(internal.cloudAgent.firstContact, { phone });
          const host: AgentHost = {
            context: (p) => ctx.runQuery(api.agent.context, { phone: p }),
            ensureUser: (p) => ctx.runMutation(api.agent.ensureUser, { phone: p }),
            saveProfile: (p, patch) => ctx.runMutation(api.agent.saveProfile, { phone: p, patch }),
            confirmContact: (p) => ctx.runMutation(api.agent.confirmContact, { phone: p }),
            addFeedback: (p, note, rating, otherName) =>
              ctx.runMutation(api.agent.addFeedback, { phone: p, note, rating, otherName }),
            updateRubricNotes: (notes) => ctx.runMutation(api.agent.updateRubricNotes, { notes }),
            setTextsPaused: (p, paused) => ctx.runMutation(api.agent.setTextsPaused, { phone: p, paused }),
          };
          const history: Turn[] = await ctx.runQuery(internal.cloudAgent.loadHistory, { phone });
          const result = await agentReply({
            host,
            apiKey: process.env.ANTHROPIC_API_KEY!,
            model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
            phone,
            text,
            history,
            situation: first ? "This is their first text to you. Greet them, then start onboarding." : undefined,
          });
          await ctx.runMutation(internal.cloudAgent.saveHistory, { phone, turns: JSON.stringify(result.history) });
          bubbles = result.bubbles;
        } catch (e) {
          console.error("agent reply failed", e);
          note(e);
          bubbles = ["Sorry, I hit a snag on my end. Mind sending that again in a minute?"];
        }
        try {
          for (const [i, b] of bubbles.entries()) {
            await sendText(last.spaceId, last.agentUserId, b, `reply:${last.id}:${i}`);
          }
          console.log(`[agent -> ${phone}] ${bubbles.join(" | ")}`);
          // First conversation: hand over the agent's contact card (name and headshot)
          if (first) await sendContactCard(ctx, phone, last.spaceId, last.agentUserId, last.id);
        } catch (e) {
          console.error(`reply to ${phone} failed`, e);
          note(e);
        }
      }

      // 2. Send queued texts
      const pending = await ctx.runQuery(internal.cloudAgent.pendingTexts, {});
      for (const t of pending) {
        // With our own SMS number the agent can text anyone first.
        const sms = smsLine();
        const convo = sms
          ? await openDirect(sms, t.phone, "sms").catch((e) => {
              console.error(`open SMS thread with ${t.phone} failed`, e);
              return null;
            })
          : await ctx.runQuery(internal.cloudAgent.conversationFor, { phone: t.phone });
        if (!convo) {
          await ctx.runMutation(internal.cloudAgent.markText, {
            id: t._id,
            sent: false,
            waiting: true,
            failed: "they never texted the agent line, so it could not text first",
          });
          continue;
        }
        try {
          await sendText(convo.spaceId, convo.agentUserId, t.body, `outbox:${t._id}`);
          await ctx.runMutation(internal.cloudAgent.markText, { id: t._id, sent: true });
        } catch (e) {
          const reason = e instanceof PhotonError ? e.message : String(e);
          console.error(`send to ${t.phone} failed`, reason);
          note(e);
          await ctx.runMutation(internal.cloudAgent.markText, { id: t._id, sent: false, failed: reason });
        }
      }
    } catch (e) {
      console.error("agent tick failed", e);
      note(e);
      throw e;
    } finally {
      await ctx.runMutation(internal.cloudAgent.release, { since, seen: [...seen], inbound: inboundCount > 0, error });
    }
  },
});

/**
 * Dry run of the brain without iMessage: `npx convex run cloudAgent:selfTest '{"text":"help"}'`.
 * Uses a throwaway demo phone and saves no history.
 */
export const selfTest = internalAction({
  args: { text: v.string(), phone: v.optional(v.string()) },
  handler: async (ctx, { text, phone }) => {
    const p = phone ?? "+14155550100";
    const host: AgentHost = {
      context: (x) => ctx.runQuery(api.agent.context, { phone: x }),
      ensureUser: (x) => ctx.runMutation(api.agent.ensureUser, { phone: x }),
      saveProfile: (x, patch) => ctx.runMutation(api.agent.saveProfile, { phone: x, patch }),
      confirmContact: async () => null,
      addFeedback: async () => null,
      updateRubricNotes: async () => null,
      setTextsPaused: async () => null,
    };
    const result = await agentReply({
      host,
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
      phone: p,
      text,
      history: [],
      situation: "This is their first text to you. Greet them, then start onboarding.",
    });
    return result.bubbles;
  },
});

/** The agent's vCard for the line this person texts. Best effort: a failure never blocks a reply. */
async function sendContactCard(ctx: ActionCtx, phone: string, spaceId: string, agentUserId: string, key: string) {
  try {
    const line = (await ctx.runQuery(internal.cloudAgent.agentLineFor, { phone })) ?? (await lineFor(phone));
    if (!line) return;
    const card = new TextEncoder().encode(agentVCard(line, AGENT_PHOTO_JPEG_BASE64));
    const id = await uploadAttachment(card, "text/vcard", "Badge Agent.vcf", `card:${line}:${phone}`);
    await sendAttachment(spaceId, agentUserId, id, `card:${key}`);
    console.log(`[agent -> ${phone}] contact card for ${line}`);
  } catch (e) {
    console.error(`contact card for ${phone} failed`, e);
  }
}

export const agentLineFor = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const u = await ctx.db.query("users").withIndex("by_phone", (q) => q.eq("phone", normalizePhone(phone))).unique();
    return u?.agentLine ?? null;
  },
});

/** Send the agent's contact card into an existing thread: `npx convex run cloudAgent:sendCard '{"phone":"+1..."}'` */
export const sendCard = internalAction({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const convo = await ctx.runQuery(internal.cloudAgent.conversationFor, { phone: normalizeHandle(phone) });
    if (!convo) return "no thread yet: they need to text the line first";
    await sendContactCard(ctx, phone, convo.spaceId, convo.agentUserId, `manual:${Date.now()}`);
    return "sent";
  },
});
