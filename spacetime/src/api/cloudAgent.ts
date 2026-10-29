import type { ProcedureCtx } from "spacetimedb/server";
import type { S, Tx } from "../schema";
import { agentReply, type AgentHost, type Turn } from "../lib/agentCore";
import { claudeModel } from "../lib/claude";
import { AGENT_PHOTO_JPEG_BASE64 } from "../lib/agentPhoto";
import { isWelcome, nowMs } from "../lib/db";
import type { HttpClient } from "../lib/httpClient";
import { normalizePhone } from "../lib/phone";
import {
  agentVCard,
  lineFor,
  normalizeHandle,
  PhotonError,
  photonConfigured,
  receivedSince,
  sendAttachment,
  sendText,
  setTyping,
  uploadAttachment,
  utf8,
  type PhotonEnv,
  type PhotonInbound,
} from "../lib/photonApi";
import * as agent from "./agent";

/**
 * Port of backend/convex/cloudAgent.ts. A schedule table runs `tick` every 5 seconds:
 *   1. read new iMessages from Photon and answer each with Claude,
 *   2. send queued texts (heads ups, "save their contact?", recaps).
 * Turned on by setting PHOTON_API_KEY, PHOTON_PROJECT_ID and ANTHROPIC_API_KEY.
 * Only run one agent per Photon line: turn the Convex one off (unset its
 * PHOTON_* env) while this one is on, or texts get answered twice.
 */

const LEASE_MS = 90_000;
const MAX_SEND_ATTEMPTS = 30; // about 2.5 minutes of retries at the 5 s tick, once a thread exists
const WAIT_FOR_FIRST_TEXT_MS = 6 * 3600_000; // heads ups and recaps go stale
const WELCOME_WAIT_MS = 7 * 24 * 3600_000;
const KEY = "photon";

function acquire(tx: Tx) {
  const now = nowMs(tx);
  const row = tx.db.agentCursor.key.find(KEY);
  if (row && row.lockedUntil > now) return null;
  if (!row) {
    const since = new Date(now).toISOString();
    tx.db.agentCursor.insert({ key: KEY, since, seen: [], lockedUntil: now + LEASE_MS });
    return { since, seen: [] as string[] };
  }
  tx.db.agentCursor.key.update({ ...row, lockedUntil: now + LEASE_MS });
  return { since: row.since, seen: row.seen };
}

function release(tx: Tx, since: string, seen: string[]) {
  const row = tx.db.agentCursor.key.find(KEY);
  if (row) tx.db.agentCursor.key.update({ ...row, since, seen: seen.slice(-300), lockedUntil: 0 });
}

function markText(tx: Tx, id: string, sent: boolean, failed?: string, waiting = false) {
  const row = tx.db.outbox.id.find(id);
  if (!row) return;
  const now = nowMs(tx);
  if (sent) return void tx.db.outbox.id.update({ ...row, sent: true, sentAt: now });
  if (waiting) {
    // No thread yet: hold it until they text the line, then it goes out.
    const limit = isWelcome(tx, id) ? WELCOME_WAIT_MS : WAIT_FOR_FIRST_TEXT_MS;
    if (now - row.at > limit) tx.db.outbox.id.update({ ...row, sent: true, sentAt: now, failed: failed ?? "expired" });
    return;
  }
  const attempts = row.attempts + 1;
  if (attempts >= MAX_SEND_ATTEMPTS) tx.db.outbox.id.update({ ...row, attempts, sent: true, sentAt: now, failed: failed ?? "gave up" });
  else tx.db.outbox.id.update({ ...row, attempts });
}

/** Their first text ever? Then the reply is the greeting and the queued welcome is dropped. */
function firstContact(tx: Tx, phone: string) {
  const history = tx.db.agentHistory.phone.find(phone);
  for (const w of tx.db.welcomeTexts.phone.filter(phone)) {
    const row = tx.db.outbox.id.find(w.outboxId);
    if (row && !row.sent) {
      tx.db.outbox.id.update({ ...row, sent: true, sentAt: nowMs(tx), failed: "superseded: greeted in the first reply" });
    }
  }
  return !history;
}

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

/** The agent's vCard for the line this person texts. Best effort: a failure never blocks a reply. */
export function sendContactCard(ctx: ProcedureCtx<S>, phone: string, spaceId: string, agentUserId: string, key: string) {
  const http: HttpClient = ctx.http;
  const env: PhotonEnv = ctx.env;
  try {
    const saved = ctx.withTx((tx) => tx.db.agentLines.phone.find(normalizePhone(phone))?.line);
    const line = saved ?? lineFor(http, env, phone);
    if (!line) return;
    const card = utf8(agentVCard(line, AGENT_PHOTO_JPEG_BASE64));
    const id = uploadAttachment(http, env, card, "text/vcard", "Badge Agent.vcf", `card:${line}:${phone}`);
    sendAttachment(http, env, spaceId, agentUserId, id, `card:${key}`);
    console.log(`[agent -> ${phone}] contact card for ${line}`);
  } catch (e) {
    console.error(`contact card for ${phone} failed`, e);
  }
}

/** cloudAgent:sendCard. Send the agent's contact card into an existing thread. */
export function sendCard(ctx: ProcedureCtx<S>, phone: string) {
  if (!photonConfigured(ctx.env)) return "Photon is not configured";
  const convo = ctx.withTx((tx) => tx.db.photonConversations.phone.find(normalizeHandle(normalizePhone(phone))));
  if (!convo) return "no thread yet: they need to text the line first";
  const key = ctx.withTx((tx) => `manual:${nowMs(tx)}`);
  sendContactCard(ctx, normalizePhone(phone), convo.spaceId, convo.agentUserId, key);
  return "sent";
}

export function tick(ctx: ProcedureCtx<S>) {
  const env = ctx.env;
  if (!photonConfigured(env) || !env.ANTHROPIC_API_KEY) return;
  const lease = ctx.withTx(acquire);
  if (!lease) return;

  let { since } = lease;
  const seen = new Set(lease.seen);
  try {
    // 1. Answer new texts
    const inbound = receivedSince(ctx.http, env, since).filter((m) => !seen.has(m.id));
    for (const m of inbound) {
      seen.add(m.id);
      if (m.createdAt > since) since = m.createdAt;
    }
    for (const [phone, { last, texts }] of groupByPhone(inbound)) {
      ctx.withTx((tx) => {
        const key = normalizeHandle(phone);
        const row = { phone: key, spaceId: last.spaceId, agentUserId: last.agentUserId, updatedAt: nowMs(tx) };
        if (tx.db.photonConversations.phone.find(key)) tx.db.photonConversations.phone.update(row);
        else tx.db.photonConversations.insert(row);
      });
      if (texts.length === 0) continue; // an image or tapback only
      const text = texts.join("\n");
      console.log(`[${phone}] ${text}`);
      setTyping(ctx.http, env, last.spaceId, last.agentUserId, true);
      let reply: string;
      let first = false;
      try {
        first = ctx.withTx((tx) => firstContact(tx, phone));
        const host: AgentHost = {
          context: (p) => ctx.withTx((tx) => agent.context(tx, p)),
          ensureUser: (p) => ctx.withTx((tx) => agent.ensureUser(tx, p)),
          saveProfile: (p, patch) => ctx.withTx((tx) => agent.saveProfile(tx, p, patch)),
          confirmContact: (p) => ctx.withTx((tx) => agent.confirmContact(tx, p)),
          addFeedback: (p, note, rating, otherName) => ctx.withTx((tx) => agent.addFeedback(tx, p, note, rating, otherName)),
          updateRubricNotes: (notes) => ctx.withTx((tx) => agent.updateRubricNotes(tx, notes)),
        };
        const history = ctx.withTx((tx) => {
          const row = tx.db.agentHistory.phone.find(phone);
          return row ? (JSON.parse(row.turns) as Turn[]) : [];
        });
        const result = agentReply({
          http: ctx.http,
          host,
          apiKey: env.ANTHROPIC_API_KEY!,
          model: claudeModel(env),
          phone,
          text,
          history,
          situation: first ? "This is their first text to you. Greet them, then start onboarding." : undefined,
        });
        const turns = JSON.stringify(result.history);
        ctx.withTx((tx) => {
          const row = { phone, turns, updatedAt: nowMs(tx) };
          if (tx.db.agentHistory.phone.find(phone)) tx.db.agentHistory.phone.update(row);
          else tx.db.agentHistory.insert(row);
        });
        reply = result.reply;
      } catch (e) {
        console.error("agent reply failed", e);
        reply = "Sorry, I hit a snag on my end. Mind sending that again in a minute?";
      }
      try {
        sendText(ctx.http, env, last.spaceId, last.agentUserId, reply, `reply:${last.id}`);
        console.log(`[agent -> ${phone}] ${reply}`);
        // First conversation: hand over the agent's contact card (name and headshot)
        if (first) sendContactCard(ctx, phone, last.spaceId, last.agentUserId, last.id);
      } catch (e) {
        console.error(`reply to ${phone} failed`, e);
      }
    }

    // 2. Send queued texts
    const pending = ctx.withTx((tx) =>
      [...tx.db.outbox.sent.filter(false)].sort((x, y) => x.at - y.at).slice(0, 50).map((t) => ({
        ...t,
        convo: tx.db.photonConversations.phone.find(normalizeHandle(t.phone)),
      })),
    );
    for (const t of pending) {
      if (!t.convo) {
        ctx.withTx((tx) => markText(tx, t.id, false, "they never texted the agent line, so it could not text first", true));
        continue;
      }
      try {
        sendText(ctx.http, env, t.convo.spaceId, t.convo.agentUserId, t.body, `outbox:${t.id}`);
        ctx.withTx((tx) => markText(tx, t.id, true));
      } catch (e) {
        const reason = e instanceof PhotonError ? e.message : String(e);
        console.error(`send to ${t.phone} failed`, reason);
        ctx.withTx((tx) => markText(tx, t.id, false, reason));
      }
    }
  } finally {
    const seenList = [...seen];
    ctx.withTx((tx) => release(tx, since, seenList));
  }
}
