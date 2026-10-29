import { nowMs, queueText } from "../lib/db";
import type { Tx } from "../schema";

/**
 * The text after you meet someone ("Nice meeting Maya ... Save their
 * contact? Reply Y"). It waits for the conversation summary (api/summarize.ts)
 * so the recap is in the same text, and goes out without it if the summary
 * fails or takes longer than about 2 minutes. Short encounters that the
 * encounter logic discards get no text at all.
 */

export const FOLLOW_UP_WAIT_MS = 120_000;
/** Encounters shorter than this are dropped (no record, no text) unless the person turned that off. */
export const SHORT_ENCOUNTER_MS = 60_000;
export const NO_RECORDING = "No recording for this conversation.";

export function hasSummary(summary: string | undefined) {
  return Boolean(summary && summary.trim() && summary !== NO_RECORDING);
}

/** Queue the post meeting text for one person (idempotent per person and conversation). */
export function queueFollowUp(tx: Tx, conversationId: string, userId: string) {
  const me = tx.db.users.id.find(userId);
  if (!me) return undefined;
  for (const m of tx.db.outboxMeta.iter()) {
    if (m.kind === "followup" && m.conversationId === conversationId && tx.db.outbox.id.find(m.outboxId)?.phone === me.phone) {
      return m.outboxId;
    }
  }
  // The body is written when it goes out (see followUpText), once the summary is in.
  return queueText(tx, me.phone, "Save their contact? Reply Y", undefined, {
    kind: "followup",
    conversationId,
    holdUntil: nowMs(tx) + FOLLOW_UP_WAIT_MS,
  });
}

/** Summarizing failed: stop waiting for it. */
export function releaseFollowUps(tx: Tx, conversationId: string) {
  const now = nowMs(tx);
  for (const m of [...tx.db.outboxMeta.iter()]) {
    if (m.kind === "followup" && m.conversationId === conversationId && (m.holdUntil ?? 0) > now) {
      tx.db.outboxMeta.outboxId.update({ ...m, holdUntil: now });
    }
  }
}

type Encounter = { activeMs?: number; hiddenFor?: string[] };
type Prefs = { dropShortEncounters?: boolean };

/**
 * The encounter bookkeeping (encounters, user_prefs) belongs to the nearby
 * and badge logic; read it when present so this file never decides on its own
 * that a short encounter counts.
 */
function encounterOf(tx: Tx, conversationId: string): Encounter | undefined {
  const table = (tx.db as unknown as Record<string, { conversationId?: { find(id: string): Encounter | undefined } }>).encounters;
  return table?.conversationId?.find(conversationId) ?? undefined;
}

function prefsOf(tx: Tx, userId: string): Prefs | undefined {
  const table = (tx.db as unknown as Record<string, { userId?: { find(id: string): Prefs | undefined } }>).userPrefs;
  return table?.userId?.find(userId) ?? undefined;
}

export type FollowUpDecision = { hold: true } | { drop: string } | { body: string };

/** Decide what to do with a queued follow up right now. */
export function followUpText(tx: Tx, phone: string, conversationId: string | undefined, holdUntil: number | undefined): FollowUpDecision {
  const c = conversationId ? tx.db.conversations.id.find(conversationId) : undefined;
  if (!c) return { drop: "encounter discarded" };
  const me = tx.db.users.phone.find(phone);
  if (!me) return { drop: "no such user" };
  const otherId = c.a === me.id ? c.b : c.a;
  const them = tx.db.users.id.find(otherId);

  const enc = encounterOf(tx, c.id);
  if (enc?.hiddenFor?.includes(me.id)) return { drop: "short encounter (hidden)" };
  const together = enc?.activeMs ?? (c.endedAt !== undefined ? c.endedAt - c.startedAt : undefined);
  const dropShort = prefsOf(tx, me.id)?.dropShortEncounters !== false;
  if (dropShort && together !== undefined && together < SHORT_ENCOUNTER_MS) return { drop: "short encounter" };

  const ready = hasSummary(c.summary);
  if (!ready && nowMs(tx) < (holdUntil ?? 0)) return { hold: true };

  const followUp = c.a === me.id ? c.followUpForA : c.followUpForB;
  const name = them?.name ?? "them";
  const parts = [
    `Nice meeting ${name}${them?.headline ? ` (${them.headline})` : ""}.`,
    ready ? `Quick recap: ${c.summary!.trim()}` : undefined,
    ready && followUp ? `Follow up idea: ${followUp.trim()}` : undefined,
    `Save ${them?.name ? `${name}'s` : "their"} contact? Reply Y`,
  ].filter(Boolean);
  return { body: parts.join(" ") };
}
