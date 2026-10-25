import { PROXIMITY_FRESH_MS, STALE_CONVERSATION_MS } from "../lib/constants";
import { after, latestConversation, log, newId, nowMs, pairKey, queueText } from "../lib/db";
import type { Tx } from "../schema";
import { optStr, str, type Ctx } from "./context";

/** Port of backend/convex/conversations.ts. Summaries run in procedures.ts. */

/** Open a conversation for this canonical pair if one is not already open. */
export function openConversation(tx: Tx, a: string, b: string) {
  const latest = latestConversation(tx, a, b);
  if (latest && latest.endedAt === undefined) return latest.id;
  const id = newId(tx);
  tx.db.conversations.insert({
    id,
    pair: pairKey(a, b),
    a,
    b,
    startedAt: nowMs(tx),
    endedAt: undefined,
    transcript: undefined,
    summary: undefined,
    topics: undefined,
    followUpForA: undefined,
    followUpForB: undefined,
  });
  const ua = tx.db.users.id.find(a);
  const ub = tx.db.users.id.find(b);
  log(tx, a, b, "talked", `Talked with ${ub?.name ?? "them"}`);
  log(tx, b, a, "talked", `Talked with ${ua?.name ?? "them"}`);
  return id;
}

/**
 * The phone stops recording when the badge leaves the talking state and sends
 * the on-device transcript here. Both phones may call it; the longer
 * transcript wins and the follow up texts go out once.
 */
export function finish({ tx }: Ctx, args: Record<string, unknown>) {
  endConversation(tx, str(args, "conversationId"), optStr(args, "transcript"));
  return null;
}

/** End a conversation (idempotent). Texts go out once; summary runs after uploads settle. */
export function endConversation(tx: Tx, conversationId: string, transcript?: string) {
  const c = tx.db.conversations.id.find(conversationId);
  if (!c) return;
  const longer = (transcript?.length ?? 0) > (c.transcript?.length ?? 0) ? transcript : c.transcript;
  const firstFinish = c.endedAt === undefined;
  tx.db.conversations.id.update({ ...c, endedAt: c.endedAt ?? nowMs(tx), transcript: longer });

  if (firstFinish) {
    const ua = tx.db.users.id.find(c.a);
    const ub = tx.db.users.id.find(c.b);
    for (const [me, them] of [[ua, ub], [ub, ua]] as const) {
      if (!me || !them) continue;
      queueText(
        tx,
        me.phone,
        `Looks like you just talked with ${them.name ?? "someone"}${them.headline ? ` (${them.headline})` : ""}. Save their contact? Reply Y`,
      );
    }
  }
  // Summarize after the second phone has had a moment to upload too.
  if (firstFinish || transcript) {
    tx.db.summarizeJob.insert({ scheduledId: 0n, scheduledAt: after(tx, 8_000), conversationId });
  }
}

/**
 * Safety net (every minute): end conversations whose phones stopped reporting
 * or who are no longer close, in case an app died before calling finish.
 */
export function closeStale(tx: Tx) {
  const now = nowMs(tx);
  const open = [...tx.db.conversations.iter()].filter((c) => c.endedAt === undefined);
  for (const c of open) {
    if (now - c.startedAt < STALE_CONVERSATION_MS) continue;
    const row = tx.db.proximity.id.find(pairKey(c.a, c.b));
    const fresh = row && now - row.at < PROXIMITY_FRESH_MS;
    const stillClose = fresh && row.closeSince !== undefined;
    if (!stillClose) endConversation(tx, c.id);
  }
}
