import type { ProcedureCtx } from "spacetimedb/server";
import type { S, Tx } from "../schema";
import { agentReply, type AgentHost, type Turn } from "../lib/agentCore";
import { claudeModel } from "../lib/claude";
import { AGENT_PHOTO_JPEG_BASE64 } from "../lib/agentPhoto";
import { isWelcome, newId, nowMs } from "../lib/db";
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
} from "../lib/photonApi";
import * as agent from "./agent";
import { followUpText } from "./followUp";

/**
 * Port of backend/convex/cloudAgent.ts. A schedule table runs `tick` every 5 seconds:
 *   1. store new iMessages from Photon (once each, by message id),
 *   2. answer each burst with exactly one reply,
 *   3. send queued texts (heads ups, follow ups, recaps), paced.
 * Turned on by setting PHOTON_API_KEY, PHOTON_PROJECT_ID and ANTHROPIC_API_KEY.
 * Only run one agent per Photon line: turn the Convex one off (unset its
 * PHOTON_* env) while this one is on, or texts get answered twice.
 *
 * Why people got two or three replies to one text, and what stops it now:
 * - The old tick held a 90 s lease and saved its cursor only at the very end.
 *   One tick with a few Claude calls (60 s timeout, up to 5 steps each) ran
 *   past the lease, the next tick took the lease, read from the old cursor and
 *   answered the same texts again. Now every message is stored once in
 *   agent_inbox (primary key = Photon id) and the cursor is saved right away;
 *   a reply belongs to an agent_turns row that one tick claims, so a second
 *   tick skips it.
 * - A burst split across two ticks ("hey" ... "I'm Ethan") became two turns
 *   and two replies. Now a burst is answered only after the person has been
 *   quiet for BURST_QUIET_MS, and a new burst waits until the previous reply
 *   went out.
 * - The reply text was generated again on every retry, so the idempotency key
 *   could not dedupe it. Now the reply is stored on the turn before sending
 *   and every retry sends the same text with the same key (reply:<inbound id>).
 * - On a dedicated line the sign up welcome went out right away, and their
 *   first text was answered with a second greeting plus the contact card.
 *   Now an already welcomed person is not greeted again, and the card is
 *   sent once per person (agent_pace.cardAt).
 * - Queued texts all went out in the same tick. Now at most one per person
 *   per tick, at least MIN_GAP_MS apart, never while a reply is pending, and
 *   no second unsolicited text until they answer the first (or it is old).
 * - The legacy Convex deployment (until go-live.sh runs) answers the same line
 *   too, and splits each answer into up to 3 bubbles: that alone looks like
 *   two or three replies. Only one backend may hold PHOTON_* keys.
 */

const LEASE_MS = 5 * 60_000; // renewed while the tick runs
const CLAIM_MS = 6 * 60_000; // a turn being answered (longer than the slowest Claude run); another tick leaves it alone
const BURST_QUIET_MS = 4_000; // group texts that arrive within a few seconds
const BURST_MAX_WAIT_MS = 12_000; // but never make them wait longer than this
const CURSOR_OVERLAP_MS = 60_000; // re-read a minute back; the inbox dedupes
const INBOX_KEEP_MS = 24 * 3600_000;
const MAX_REPLY_ATTEMPTS = 8;
const MIN_GAP_MS = 45_000; // between any two texts the agent starts
const UNANSWERED_HOLD_MS = 10 * 60_000; // one unsolicited text in a row, unless the last one is this old
const MAX_SEND_ATTEMPTS = 30; // about 2.5 minutes of retries at the 5 s tick, once a thread exists
const WAIT_FOR_FIRST_TEXT_MS = 6 * 3600_000; // heads ups and recaps go stale
const WELCOME_WAIT_MS = 7 * 24 * 3600_000;
const KEY = "photon";

const keyOf = (phone: string) => normalizeHandle(normalizePhone(phone));

// Lease and cursor -------------------------------------------------------------

function acquire(tx: Tx) {
  const now = nowMs(tx);
  const row = tx.db.agentCursor.key.find(KEY);
  if (row && row.lockedUntil > now) return null;
  if (!row) {
    const since = new Date(now).toISOString();
    tx.db.agentCursor.insert({ key: KEY, since, seen: [], lockedUntil: now + LEASE_MS });
    return { since };
  }
  tx.db.agentCursor.key.update({ ...row, lockedUntil: now + LEASE_MS });
  return { since: row.since };
}

function renew(tx: Tx) {
  const row = tx.db.agentCursor.key.find(KEY);
  if (row) tx.db.agentCursor.key.update({ ...row, lockedUntil: nowMs(tx) + LEASE_MS });
}

function release(tx: Tx) {
  const row = tx.db.agentCursor.key.find(KEY);
  if (row) tx.db.agentCursor.key.update({ ...row, lockedUntil: 0 });
}

function pace(tx: Tx, phone: string) {
  const key = keyOf(phone);
  return tx.db.agentPace.phone.find(key) ?? { phone: key, lastInAt: 0, lastOutAt: 0, lastUnsolicitedAt: 0, cardAt: undefined };
}

function savePace(tx: Tx, row: ReturnType<typeof pace>) {
  if (tx.db.agentPace.phone.find(row.phone)) tx.db.agentPace.phone.update(row);
  else tx.db.agentPace.insert(row);
}

/** A text the agent sent on its own (e.g. the welcome from photonAssign), for pacing. */
export function noteUnsolicited(tx: Tx, phone: string) {
  const now = nowMs(tx);
  savePace(tx, { ...pace(tx, phone), lastOutAt: now, lastUnsolicitedAt: now });
}

// 1. Inbox -----------------------------------------------------------------------

/** Read new texts from Photon and store each one once. The cursor is saved here, not at the end. */
function ingest(ctx: ProcedureCtx<S>, since: string) {
  const from = new Date(Math.max(0, Date.parse(since) - CURSOR_OVERLAP_MS)).toISOString();
  const inbound = receivedSince(ctx.http, ctx.env, from);
  ctx.withTx((tx) => {
    const now = nowMs(tx);
    let cursor = since;
    for (const m of inbound) {
      if (m.createdAt > cursor) cursor = m.createdAt;
      if (tx.db.agentInbox.id.find(m.id)) continue;
      const phone = normalizePhone(m.from);
      tx.db.agentInbox.insert({
        id: m.id,
        phone,
        text: m.text?.trim() || undefined,
        createdAt: m.createdAt,
        receivedAt: now,
        spaceId: m.spaceId,
        agentUserId: m.agentUserId,
        turnId: undefined,
      });
      const key = normalizeHandle(phone);
      const convo = { phone: key, spaceId: m.spaceId, agentUserId: m.agentUserId, updatedAt: now };
      if (tx.db.photonConversations.phone.find(key)) tx.db.photonConversations.phone.update(convo);
      else tx.db.photonConversations.insert(convo);
      savePace(tx, { ...pace(tx, phone), lastInAt: now });
    }
    const row = tx.db.agentCursor.key.find(KEY);
    if (row) tx.db.agentCursor.key.update({ ...row, since: cursor, seen: [] });
    // Old inbox rows and finished turns are not needed after a day
    for (const r of [...tx.db.agentInbox.iter()]) if (now - r.receivedAt > INBOX_KEEP_MS) tx.db.agentInbox.id.delete(r.id);
    for (const t of [...tx.db.agentTurns.iter()]) if (t.sentAt !== undefined && now - t.at > INBOX_KEEP_MS) tx.db.agentTurns.id.delete(t.id);
  });
}

// 2. Turns -------------------------------------------------------------------------

type Claimed = {
  id: string;
  claim: string;
  phone: string;
  text: string;
  spaceId: string;
  agentUserId: string;
  reply?: string;
};

function unfinishedTurn(tx: Tx, phone: string) {
  return [...tx.db.agentTurns.phone.filter(phone)].find((t) => t.sentAt === undefined);
}

/**
 * Claim the turns this tick answers: a person's unanswered texts become one
 * turn once they have gone quiet, and a turn that a dead tick left behind is
 * picked up again after its claim runs out.
 */
function claimTurns(tx: Tx): Claimed[] {
  const now = nowMs(tx);
  const out: Claimed[] = [];
  const byPhone = new Map<string, NonNullable<ReturnType<Tx["db"]["agentInbox"]["id"]["find"]>>[]>();
  for (const r of tx.db.agentInbox.iter()) {
    if (r.turnId !== undefined) continue;
    byPhone.set(r.phone, [...(byPhone.get(r.phone) ?? []), r]);
  }
  const phones = new Set([...byPhone.keys(), ...[...tx.db.agentTurns.iter()].filter((t) => t.sentAt === undefined).map((t) => t.phone)]);

  for (const phone of phones) {
    const claim = newId(tx);
    const open = unfinishedTurn(tx, phone);
    if (open) {
      // One turn at a time per person. Pick it up again only if its claim ran out.
      if (open.claimedUntil > now) continue;
      tx.db.agentTurns.id.update({ ...open, claim, claimedUntil: now + CLAIM_MS });
      const rows = [...tx.db.agentInbox.phone.filter(phone)].filter((r) => r.turnId === open.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
      const last = rows[rows.length - 1];
      if (!last) {
        tx.db.agentTurns.id.update({ ...open, sentAt: now, failed: "inbox rows gone" });
        continue;
      }
      out.push({ id: open.id, claim, phone, text: rows.map((r) => r.text).filter(Boolean).join("\n"), spaceId: last.spaceId, agentUserId: last.agentUserId, reply: open.reply });
      continue;
    }

    const rows = (byPhone.get(phone) ?? []).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    if (rows.length === 0) continue;
    const last = rows[rows.length - 1];
    const first = rows[0];
    const created = Date.parse(last.createdAt);
    const quiet = (Number.isFinite(created) && now - created >= BURST_QUIET_MS) || now - last.receivedAt >= BURST_QUIET_MS + 5_000;
    const waitedEnough = now - first.receivedAt >= BURST_MAX_WAIT_MS;
    if (!quiet && !waitedEnough) continue;

    for (const r of rows) tx.db.agentInbox.id.update({ ...r, turnId: last.id });
    const text = rows.map((r) => r.text).filter(Boolean).join("\n");
    if (!text) continue; // an image or tapback only: nothing to answer
    if (tx.db.agentTurns.id.find(last.id)) continue; // answered already
    tx.db.agentTurns.insert({
      id: last.id,
      phone,
      claim,
      claimedUntil: now + CLAIM_MS,
      reply: undefined,
      sentAt: undefined,
      attempts: 0,
      failed: undefined,
      at: now,
    });
    out.push({ id: last.id, claim, phone, text, spaceId: last.spaceId, agentUserId: last.agentUserId });
  }
  return out;
}

function stillMine(tx: Tx, turn: Claimed) {
  const row = tx.db.agentTurns.id.find(turn.id);
  return row && row.claim === turn.claim && row.sentAt === undefined ? row : null;
}

/** First text ever? Then the reply greets them (unless the welcome already did) and drops a queued welcome. */
function firstContact(tx: Tx, phone: string) {
  let welcomed = false;
  for (const w of tx.db.welcomeTexts.phone.filter(phone)) {
    const row = tx.db.outbox.id.find(w.outboxId);
    if (!row) continue;
    if (row.sent && !row.failed) welcomed = true;
    if (!row.sent) tx.db.outbox.id.update({ ...row, sent: true, sentAt: nowMs(tx), failed: "superseded: greeted in the first reply" });
  }
  return { first: !tx.db.agentHistory.phone.find(phone), welcomed, needsCard: pace(tx, phone).cardAt === undefined };
}

/** Write the reply (once) and store it on the turn together with the history. */
function compose(ctx: ProcedureCtx<S>, turn: Claimed): { reply: string; card: boolean } | null {
  const env = ctx.env;
  const intro = ctx.withTx((tx) => firstContact(tx, turn.phone));
  if (turn.reply !== undefined) return { reply: turn.reply, card: intro.first && intro.needsCard };

  const host: AgentHost = {
    context: (p) => ctx.withTx((tx) => agent.context(tx, p)),
    ensureUser: (p) => ctx.withTx((tx) => agent.ensureUser(tx, p)),
    saveProfile: (p, patch) => ctx.withTx((tx) => agent.saveProfile(tx, p, patch)),
    confirmContact: (p) => ctx.withTx((tx) => agent.confirmContact(tx, p)),
    addFeedback: (p, note, rating, otherName) => ctx.withTx((tx) => agent.addFeedback(tx, p, note, rating, otherName)),
    updateRubricNotes: (notes) => ctx.withTx((tx) => agent.updateRubricNotes(tx, notes)),
  };
  let reply: string;
  let turns: string | undefined;
  try {
    const history = ctx.withTx((tx) => {
      const row = tx.db.agentHistory.phone.find(turn.phone);
      return row ? (JSON.parse(row.turns) as Turn[]) : [];
    });
    const situation = !intro.first
      ? undefined
      : intro.welcomed
        ? "This is their first text to you, and they already got your welcome text (who you are and the first onboarding question). Do not greet or introduce yourself again; just answer and continue onboarding."
        : "This is their first text to you. Greet them, then start onboarding.";
    const result = agentReply({
      http: ctx.http,
      host,
      apiKey: env.ANTHROPIC_API_KEY!,
      model: claudeModel(env),
      phone: turn.phone,
      text: turn.text,
      history,
      situation,
    });
    reply = result.reply;
    turns = JSON.stringify(result.history);
  } catch (e) {
    console.error("agent reply failed", e);
    reply = "Sorry, I hit a snag on my end. Mind sending that again in a minute?";
  }
  const saved = ctx.withTx((tx) => {
    const row = stillMine(tx, turn);
    if (!row) return false; // another tick took over; it will send its own copy once
    tx.db.agentTurns.id.update({ ...row, reply });
    if (turns !== undefined) {
      const h = { phone: turn.phone, turns, updatedAt: nowMs(tx) };
      if (tx.db.agentHistory.phone.find(turn.phone)) tx.db.agentHistory.phone.update(h);
      else tx.db.agentHistory.insert(h);
    }
    return true;
  });
  return saved ? { reply, card: intro.first && intro.needsCard } : null;
}

function answer(ctx: ProcedureCtx<S>, turn: Claimed) {
  const env = ctx.env;
  console.log(`[${turn.phone}] ${turn.text}`);
  if (turn.reply === undefined) setTyping(ctx.http, env, turn.spaceId, turn.agentUserId, true);
  const composed = compose(ctx, turn);
  if (!composed) return;
  try {
    // Same key and same text on every retry, so Photon delivers it once.
    sendText(ctx.http, env, turn.spaceId, turn.agentUserId, composed.reply, `reply:${turn.id}`);
    console.log(`[agent -> ${turn.phone}] ${composed.reply}`);
  } catch (e) {
    const reason = e instanceof PhotonError ? e.message : String(e);
    console.error(`reply to ${turn.phone} failed`, reason);
    ctx.withTx((tx) => {
      const row = stillMine(tx, turn);
      if (!row) return;
      const attempts = row.attempts + 1;
      const giveUp = attempts >= MAX_REPLY_ATTEMPTS;
      // Release the claim so the next tick retries (with the stored text)
      tx.db.agentTurns.id.update({ ...row, attempts, claimedUntil: 0, ...(giveUp ? { sentAt: nowMs(tx), failed: reason } : {}) });
    });
    return;
  }
  ctx.withTx((tx) => {
    const row = tx.db.agentTurns.id.find(turn.id);
    if (row && row.sentAt === undefined) tx.db.agentTurns.id.update({ ...row, sentAt: nowMs(tx) });
    savePace(tx, { ...pace(tx, turn.phone), lastOutAt: nowMs(tx), ...(composed.card ? { cardAt: nowMs(tx) } : {}) });
  });
  // First conversation: one short reply, then the agent's contact card (an attachment), once per person.
  if (composed.card) sendContactCard(ctx, turn.phone, turn.spaceId, turn.agentUserId, turn.id);
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
  const convo = ctx.withTx((tx) => tx.db.photonConversations.phone.find(keyOf(phone)));
  if (!convo) return "no thread yet: they need to text the line first";
  const key = ctx.withTx((tx) => `manual:${nowMs(tx)}`);
  sendContactCard(ctx, normalizePhone(phone), convo.spaceId, convo.agentUserId, key);
  ctx.withTx((tx) => savePace(tx, { ...pace(tx, phone), cardAt: nowMs(tx) }));
  return "sent";
}

// 3. Outbox -------------------------------------------------------------------------

function markText(tx: Tx, id: string, sent: boolean, failed?: string, waiting = false) {
  const row = tx.db.outbox.id.find(id);
  if (!row) return;
  const now = nowMs(tx);
  if (sent) return void tx.db.outbox.id.update({ ...row, sent: true, sentAt: now, failed });
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

type Ready = { id: string; phone: string; body: string; spaceId: string; agentUserId: string; before: ReturnType<typeof pace> };

/**
 * Pick what may go out now: at most one text per person, spaced out, held
 * while a reply is pending, and no second unsolicited text in a row until they
 * answer (or the first is old). Follow ups wait for their summary.
 */
function readyTexts(tx: Tx): Ready[] {
  const now = nowMs(tx);
  const pending = [...tx.db.outbox.sent.filter(false)].sort((x, y) => x.at - y.at).slice(0, 200);
  const picked = new Set<string>();
  const out: Ready[] = [];
  for (const t of pending) {
    const key = keyOf(t.phone);
    if (picked.has(key)) continue;
    const meta = tx.db.outboxMeta.outboxId.find(t.id);
    if (meta?.expiresAt !== undefined && now > meta.expiresAt) {
      markText(tx, t.id, true, "stale: held too long to still be useful");
      continue;
    }
    let body = t.body;
    if (meta?.kind === "followup") {
      const decision = followUpText(tx, t.phone, meta.conversationId, meta.holdUntil);
      if ("drop" in decision) {
        markText(tx, t.id, true, decision.drop);
        continue;
      }
      if ("hold" in decision) continue; // waiting for the summary; a later text for them may go first
      body = decision.body;
    }
    const convo = tx.db.photonConversations.phone.find(key);
    if (!convo) {
      markText(tx, t.id, false, "they never texted the agent line, so it could not text first", true);
      continue;
    }
    const p = pace(tx, t.phone);
    picked.add(key); // one per person per tick, and keep their order
    if (unfinishedTurn(tx, normalizePhone(t.phone))) continue; // answering them right now
    if (now - p.lastOutAt < MIN_GAP_MS) continue; // also covers a reply that just went out
    const unanswered = p.lastUnsolicitedAt > p.lastInAt && now - p.lastUnsolicitedAt < UNANSWERED_HOLD_MS;
    if (unanswered) continue;
    // Claim the send slot now so an overlapping tick cannot send a second text to them
    savePace(tx, { ...p, lastOutAt: now, lastUnsolicitedAt: now });
    out.push({ id: t.id, phone: t.phone, body, spaceId: convo.spaceId, agentUserId: convo.agentUserId, before: p });
  }
  return out;
}

function deliverOutbox(ctx: ProcedureCtx<S>) {
  const ready = ctx.withTx(readyTexts);
  for (const t of ready) {
    try {
      sendText(ctx.http, ctx.env, t.spaceId, t.agentUserId, t.body, `outbox:${t.id}`);
      ctx.withTx((tx) => {
        const row = tx.db.outbox.id.find(t.id);
        // Keep what actually went out (follow ups are written at send time)
        if (row && row.body !== t.body) tx.db.outbox.id.update({ ...row, body: t.body });
        markText(tx, t.id, true);
      });
      console.log(`[agent -> ${t.phone}] ${t.body}`);
    } catch (e) {
      const reason = e instanceof PhotonError ? e.message : String(e);
      console.error(`send to ${t.phone} failed`, reason);
      ctx.withTx((tx) => {
        markText(tx, t.id, false, reason);
        // Not sent: give the slot back so the retry is not held for a minute
        savePace(tx, { ...pace(tx, t.phone), lastOutAt: t.before.lastOutAt, lastUnsolicitedAt: t.before.lastUnsolicitedAt });
      });
    }
  }
}

// The tick ----------------------------------------------------------------------------

export function tick(ctx: ProcedureCtx<S>) {
  const env = ctx.env;
  if (!photonConfigured(env) || !env.ANTHROPIC_API_KEY) return;
  const lease = ctx.withTx(acquire);
  if (!lease) return;
  try {
    try {
      ingest(ctx, lease.since);
    } catch (e) {
      console.error("reading texts failed", e);
    }
    for (const turn of ctx.withTx(claimTurns)) {
      answer(ctx, turn);
      ctx.withTx(renew);
    }
    deliverOutbox(ctx);
  } finally {
    ctx.withTx(release);
  }
}
