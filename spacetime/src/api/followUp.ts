import { LEFT_GROUP_FOLLOW_UP_WAIT_MS, MIN_ENCOUNTER_MS } from "../lib/constants";
import { dropsShortEncounters, nowMs, queueText } from "../lib/db";
import type { Tx } from "../schema";
import { companionsOf, firstNames, isGroupEncounter, joinNames, memberOf } from "./groups";

/**
 * The text after you meet someone ("Nice meeting Maya ... Save their
 * contact? Reply Y"). It waits for the conversation summary (api/summarize.ts)
 * so the recap is in the same text, and goes out without it if the summary
 * fails or takes longer than about 2 minutes. Short encounters that the
 * encounter logic discards get no text at all.
 *
 * Groups: "Nice meeting Maya and Leo. Quick recap: ... Save their contacts?
 * Reply Y" names everyone the person was with, and the follow up idea is
 * their own. Someone who left a group that goes on gets theirs when it ends
 * (with the recap), or LEFT_GROUP_FOLLOW_UP_WAIT_MS after they left without it.
 */

export const FOLLOW_UP_WAIT_MS = 120_000;
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
      // Reopened and ended again before it went out: wait for the new summary
      if (!tx.db.outbox.id.find(m.outboxId)?.sent) tx.db.outboxMeta.outboxId.update({ ...m, holdUntil: nowMs(tx) + FOLLOW_UP_WAIT_MS });
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

export type FollowUpDecision = { hold: true } | { drop: string } | { body: string };

/** Decide what to do with a queued follow up right now. */
export function followUpText(tx: Tx, phone: string, conversationId: string | undefined, holdUntil: number | undefined): FollowUpDecision {
  const c = conversationId ? tx.db.conversations.id.find(conversationId) : undefined;
  if (!c) return { drop: "encounter discarded" };
  const me = tx.db.users.phone.find(phone);
  if (!me) return { drop: "no such user" };
  const otherId = c.a === me.id ? c.b : c.a;
  const them = tx.db.users.id.find(otherId);

  // "Drop short encounters" (conversations.ts): hidden for me means no text at all.
  const enc = tx.db.encounters.conversationId.find(c.id);
  const mine = memberOf(tx, c, me.id);
  const myMs = mine?.activeMs ?? enc?.activeMs;
  if (enc?.hiddenFor.includes(me.id)) return { drop: "short encounter (dropped)" };

  const now = nowMs(tx);
  let ready = hasSummary(c.summary);
  if (c.endedAt === undefined) {
    // They came back together (or I'm still with the group): wait until it ends
    if (!mine || mine.presentSince !== undefined) return { hold: true };
    // I left a group that goes on: wait for its summary, but not forever
    if (now < (mine.leftAt ?? 0) + LEFT_GROUP_FOLLOW_UP_WAIT_MS) return { hold: true };
    ready = false;
  } else if (!ready && now < (holdUntil ?? 0)) {
    return { hold: true };
  }
  if (myMs !== undefined && myMs < MIN_ENCOUNTER_MS && dropsShortEncounters(tx, me.id)) return { drop: "short encounter" };

  if (isGroupEncounter(tx, c)) {
    const others = companionsOf(tx, c, me.id);
    if (others.length >= 2) {
      const followUp = mine?.followUp;
      const parts = [
        `Nice meeting ${joinNames(firstNames(tx, others))}.`,
        ready ? `Quick recap: ${c.summary!.trim()}` : undefined,
        ready && followUp ? `Follow up idea: ${followUp.trim()}` : undefined,
        "Save their contacts? Reply Y",
      ].filter(Boolean);
      return { body: parts.join(" ") };
    }
  }

  const followUp = mine?.followUp ?? (c.a === me.id ? c.followUpForA : c.followUpForB);
  const pairOther = isGroupEncounter(tx, c) ? tx.db.users.id.find(companionsOf(tx, c, me.id)[0] ?? otherId) : them;
  const name = pairOther?.name ?? "them";
  const parts = [
    `Nice meeting ${name}${pairOther?.headline ? ` (${pairOther.headline})` : ""}.`,
    ready ? `Quick recap: ${c.summary!.trim()}` : undefined,
    ready && followUp ? `Follow up idea: ${followUp.trim()}` : undefined,
    `Save ${pairOther?.name ? `${name}'s` : "their"} contact? Reply Y`,
  ].filter(Boolean);
  return { body: parts.join(" ") };
}
