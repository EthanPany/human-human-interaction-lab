import { ScheduleAt } from "spacetimedb";
import type { Conversation, Tx } from "../schema";
import { DEFAULT_RUBRIC, MATCH_COLORS, RESCORE_DEBOUNCE_MS } from "./constants";
import { isDemoPhone } from "./phone";

/** Helpers shared by the API files (ports of convex/lib/{pairs,activity,texts,rubric,rescore}.ts). */

/** Transaction time in milliseconds (deterministic, unlike Date.now()). */
export function nowMs(tx: { timestamp: { microsSinceUnixEpoch: bigint } }): number {
  return Number(tx.timestamp.microsSinceUnixEpoch / 1000n);
}

export function newId(tx: Tx): string {
  return tx.newUuidV4().toString().replace(/-/g, "");
}

export function after(tx: Tx, ms: number) {
  return ScheduleAt.time(tx.timestamp.microsSinceUnixEpoch + BigInt(Math.round(ms)) * 1000n);
}

// Pairs ----------------------------------------------------------------------

/** Order two user ids so symmetric facts are stored once per pair. */
export function canonicalPair(x: string, y: string) {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

export function pairKey(x: string, y: string) {
  const { a, b } = canonicalPair(x, y);
  return `${a}|${b}`;
}

/** Key for directed rows (viewer -> other, owner -> other). */
export function directedKey(from: string, to: string) {
  return `${from}|${to}`;
}

export function otherOf(pair: { a: string; b: string }, me: string) {
  return pair.a === me ? pair.b : pair.a;
}

/** Same color on both badges: derived from the pair, not the viewer. */
export function pairColor(x: string, y: string) {
  const { a, b } = canonicalPair(x, y);
  let hash = 0;
  for (const ch of a + b) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return MATCH_COLORS[hash % MATCH_COLORS.length];
}

// Rows -----------------------------------------------------------------------

export function loadRubric(tx: Tx) {
  return tx.db.rubric.name.find("global") ?? { name: "global", ...DEFAULT_RUBRIC };
}

/** Append a timeline entry for `owner` (optionally about `other`). */
export function log(tx: Tx, owner: string, other: string | undefined, kind: string, text: string) {
  tx.db.activity.insert({ id: newId(tx), owner, other, kind, text, at: nowMs(tx) });
}

/** Queue a text for the agent to send. Demo profiles are skipped. Returns the outbox id. */
export function queueText(tx: Tx, phone: string, body: string, kind?: "welcome") {
  if (isDemoPhone(phone)) return undefined;
  const id = newId(tx);
  if (kind === "welcome") tx.db.welcomeTexts.insert({ outboxId: id, phone });
  tx.db.outbox.insert({
    id,
    phone,
    body,
    at: nowMs(tx),
    sent: false,
    sentAt: undefined,
    attempts: 0,
    failed: undefined,
  });
  return id;
}

/** The sign up welcome still waiting to go out for this phone, if any. */
export function pendingWelcome(tx: Tx, phone: string) {
  for (const w of tx.db.welcomeTexts.phone.filter(phone)) {
    const row = tx.db.outbox.id.find(w.outboxId);
    if (row && !row.sent) return row;
  }
  return null;
}

export function isWelcome(tx: Tx, outboxId: string) {
  return Boolean(tx.db.welcomeTexts.outboxId.find(outboxId));
}

/** Check this person's Photon line soon (api/photonAssign.ts ensure). */
export function scheduleLineCheck(tx: Tx, userId: string, delayMs = 0) {
  tx.db.photonAssignJob.insert({ scheduledId: 0n, scheduledAt: after(tx, delayMs), userId });
}

/** Mark a profile as edited and re-score it once the burst of edits settles. */
export function requestRescore(tx: Tx, userId: string) {
  const u = tx.db.users.id.find(userId);
  if (!u) return;
  const requestedAt = nowMs(tx);
  tx.db.users.id.update({ ...u, profileUpdatedAt: requestedAt });
  tx.db.rescoreJob.insert({ scheduledId: 0n, scheduledAt: after(tx, RESCORE_DEBOUNCE_MS), userId, requestedAt });
}

export function scheduleRescoreAll(tx: Tx) {
  tx.db.rescoreAllJob.insert({ scheduledId: 0n, scheduledAt: after(tx, 0) });
}

/** The latest conversation for a canonical pair (open or not). */
export function latestConversation(tx: Tx, x: string, y: string) {
  let best: Conversation | null = null;
  for (const c of tx.db.conversations.pair.filter(pairKey(x, y))) {
    if (!best || c.startedAt > best.startedAt) best = c;
  }
  return best;
}

export function conversationsOf(tx: Tx, userId: string) {
  return [...tx.db.conversations.a.filter(userId), ...tx.db.conversations.b.filter(userId)];
}

export function proximityOf(tx: Tx, userId: string) {
  return [...tx.db.proximity.a.filter(userId), ...tx.db.proximity.b.filter(userId)];
}

export function matchOf(tx: Tx, viewer: string, other: string) {
  return tx.db.matches.id.find(directedKey(viewer, other));
}

export function meetingsOf(tx: Tx, userId: string) {
  return [...tx.db.meetings.a.filter(userId), ...tx.db.meetings.b.filter(userId)];
}

export function connectionOf(tx: Tx, owner: string, other: string) {
  return tx.db.connections.id.find(directedKey(owner, other));
}

/** Throw a message the app shows as is. */
export class UserError extends Error {}
