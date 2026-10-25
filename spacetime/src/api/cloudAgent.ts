import type { ProcedureCtx } from "spacetimedb/server";
import type { S, Tx } from "../schema";
import { agentReply, type AgentHost, type Turn } from "../lib/agentCore";
import { claudeModel } from "../lib/claude";
import { nowMs } from "../lib/db";
import { normalizePhone } from "../lib/phone";
import { normalizeHandle, PhotonError, photonConfigured, receivedSince, sendText } from "../lib/photonApi";
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
const MAX_SEND_ATTEMPTS = 30;
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

function markText(tx: Tx, id: string, sent: boolean, failed?: string) {
  const row = tx.db.outbox.id.find(id);
  if (!row) return;
  const now = nowMs(tx);
  if (sent) return void tx.db.outbox.id.update({ ...row, sent: true, sentAt: now });
  const attempts = row.attempts + 1;
  if (attempts >= MAX_SEND_ATTEMPTS) tx.db.outbox.id.update({ ...row, attempts, sent: true, sentAt: now, failed: failed ?? "gave up" });
  else tx.db.outbox.id.update({ ...row, attempts });
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
    for (const m of receivedSince(ctx.http, env, since)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (m.createdAt > since) since = m.createdAt;
      const phone = normalizePhone(m.from);
      ctx.withTx((tx) => {
        const key = normalizeHandle(phone);
        const row = { phone: key, spaceId: m.spaceId, agentUserId: m.agentUserId, updatedAt: nowMs(tx) };
        if (tx.db.photonConversations.phone.find(key)) tx.db.photonConversations.phone.update(row);
        else tx.db.photonConversations.insert(row);
      });
      if (!m.text) continue;
      console.log(`[${phone}] ${m.text}`);
      let reply: string;
      try {
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
          text: m.text,
          history,
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
        reply = "Sorry, I hit a snag. Try again in a moment?";
      }
      sendText(ctx.http, env, m.spaceId, m.agentUserId, reply, `reply:${m.id}`);
      console.log(`[agent -> ${phone}] ${reply}`);
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
        ctx.withTx((tx) => markText(tx, t.id, false, "no conversation yet: they need to text the agent first"));
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
