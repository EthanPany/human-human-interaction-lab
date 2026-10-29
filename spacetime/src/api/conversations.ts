import { MIN_ENCOUNTER_MS, PROXIMITY_FRESH_MS, REJOIN_WINDOW_MS, STALE_CONVERSATION_MS } from "../lib/constants";
import { after, dropsShortEncounters, latestConversation, log, newId, nowMs, pairKey } from "../lib/db";
import type { Conversation, Encounter, Tx } from "../schema";
import { ArgError, optStr, str, type Ctx } from "./context";
import { queueFollowUp } from "./followUp";

/**
 * Port of backend/convex/conversations.ts, with encounters on top.
 *
 * One conversation row is one encounter. Two people who come back together
 * within REJOIN_WINDOW_MS after parting continue the same one (the record and
 * the transcript carry on); later than that is a new encounter with its own
 * summary. "Drop short encounters" hides encounters shorter than
 * MIN_ENCOUNTER_MS from whoever has it on (the default); hidden for both, the
 * encounter is deleted once it can no longer be rejoined. Summaries run in
 * summarize.ts.
 */

/** The encounter row for a conversation (made on the fly for rows from before encounters existed). */
export function encounterOf(tx: Tx, c: Conversation): Encounter {
  const found = tx.db.encounters.conversationId.find(c.id);
  if (found) return found;
  const row: Encounter = {
    conversationId: c.id,
    matched: true, // before encounters, only matched pairs had conversations
    segmentStartedAt: c.startedAt,
    activeMs: c.endedAt !== undefined ? Math.max(0, c.endedAt - c.startedAt) : 0,
    priorTranscript: undefined,
    segmentTranscript: c.transcript,
    hiddenFor: [],
  };
  tx.db.encounters.insert(row);
  return row;
}

/** Hidden from this person by their "Drop short encounters" setting. Ongoing encounters always show. */
export function hiddenFrom(tx: Tx, c: Conversation, userId: string) {
  if (c.endedAt === undefined) return false;
  return tx.db.encounters.conversationId.find(c.id)?.hiddenFor.includes(userId) ?? false;
}

/** Time spent together so far (milliseconds). */
export function togetherMs(tx: Tx, c: Conversation) {
  const e = tx.db.encounters.conversationId.find(c.id);
  if (!e) return Math.max(0, (c.endedAt ?? nowMs(tx)) - c.startedAt);
  return e.activeMs + (c.endedAt === undefined ? Math.max(0, nowMs(tx) - e.segmentStartedAt) : 0);
}

/**
 * The pair is together: return their open conversation, reopen the one they
 * left less than REJOIN_WINDOW_MS ago, or start a new encounter.
 */
export function openConversation(tx: Tx, a: string, b: string, matched: boolean) {
  const now = nowMs(tx);
  const latest = latestConversation(tx, a, b);
  if (latest && latest.endedAt === undefined) return latest.id;

  if (latest && latest.endedAt !== undefined && now - latest.endedAt <= REJOIN_WINDOW_MS) {
    const e = encounterOf(tx, latest);
    tx.db.conversations.id.update({ ...latest, endedAt: undefined });
    tx.db.encounters.conversationId.update({
      ...e,
      matched: e.matched || matched,
      segmentStartedAt: now,
      priorTranscript: latest.transcript,
      segmentTranscript: undefined,
      hiddenFor: [], // decided again when this segment ends
    });
    return latest.id;
  }

  const id = newId(tx);
  tx.db.conversations.insert({
    id,
    pair: pairKey(a, b),
    a,
    b,
    startedAt: now,
    endedAt: undefined,
    transcript: undefined,
    summary: undefined,
    topics: undefined,
    followUpForA: undefined,
    followUpForB: undefined,
  });
  tx.db.encounters.insert({
    conversationId: id,
    matched,
    segmentStartedAt: now,
    activeMs: 0,
    priorTranscript: undefined,
    segmentTranscript: undefined,
    hiddenFor: [],
  });
  const ua = tx.db.users.id.find(a);
  const ub = tx.db.users.id.find(b);
  log(tx, a, b, "talked", `Talked with ${ub?.name ?? "them"}`);
  log(tx, b, a, "talked", `Talked with ${ua?.name ?? "them"}`);
  return id;
}

/**
 * The phone stops recording when the badge leaves the talking state and sends
 * the on-device transcript here. Both phones may call it; for each together
 * segment the longer transcript wins, and segments append.
 */
export function finish({ tx }: Ctx, args: Record<string, unknown>) {
  endConversation(tx, str(args, "conversationId"), optStr(args, "transcript"));
  return null;
}

function longer(x: string | undefined, y: string | undefined) {
  return (y?.length ?? 0) > (x?.length ?? 0) ? y : x;
}

function joined(prior: string | undefined, segment: string | undefined) {
  const parts = [prior?.trim(), segment?.trim()].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * End the current together segment (idempotent). Short encounters are hidden
 * from people who drop them; everyone else gets the "save their contact?" text
 * once per encounter, and the summary runs after both phones had time to upload.
 * Short is MIN_ENCOUNTER_MS of time together, counted over all segments.
 */
export function endConversation(tx: Tx, conversationId: string, transcript?: string) {
  const c = tx.db.conversations.id.find(conversationId);
  if (!c) return;
  const e = encounterOf(tx, c);
  const now = nowMs(tx);
  const firstFinish = c.endedAt === undefined;

  const segmentTranscript = longer(e.segmentTranscript, transcript);
  const activeMs = firstFinish ? e.activeMs + Math.max(0, now - e.segmentStartedAt) : e.activeMs;
  const hiddenFor = firstFinish
    ? [c.a, c.b].filter((u) => activeMs < MIN_ENCOUNTER_MS && dropsShortEncounters(tx, u))
    : e.hiddenFor;
  // The "Nice meeting ... Save their contact?" text (followUp.ts: once per
  // person, waits for the summary). Dropped encounters get none.
  if (firstFinish) {
    for (const me of [c.a, c.b]) if (!hiddenFor.includes(me)) queueFollowUp(tx, c.id, me);
  }

  tx.db.conversations.id.update({ ...c, endedAt: c.endedAt ?? now, transcript: joined(e.priorTranscript, segmentTranscript) });
  tx.db.encounters.conversationId.update({ ...e, activeMs, segmentTranscript, hiddenFor });

  // Dropped for both: no summary (closeStale deletes it once it can't be rejoined).
  const kept = hiddenFor.length < 2;
  if (kept && (firstFinish || transcript)) {
    tx.db.summarizeJob.insert({ scheduledId: 0n, scheduledAt: after(tx, 8_000), conversationId });
  }
}

/**
 * Safety net (every minute): end conversations whose phones stopped reporting
 * or who are no longer close, in case an app died before calling finish; and
 * delete encounters both people dropped once they can no longer be rejoined.
 */
export function closeStale(tx: Tx) {
  const now = nowMs(tx);
  for (const c of [...tx.db.conversations.iter()]) {
    if (c.endedAt === undefined) {
      const segmentStart = tx.db.encounters.conversationId.find(c.id)?.segmentStartedAt ?? c.startedAt;
      if (now - segmentStart < STALE_CONVERSATION_MS) continue;
      const row = tx.db.proximity.id.find(pairKey(c.a, c.b));
      const fresh = row && now - row.at < PROXIMITY_FRESH_MS;
      const stillClose = fresh && row.closeSince !== undefined;
      if (!stillClose) endConversation(tx, c.id);
      continue;
    }
    const e = tx.db.encounters.conversationId.find(c.id);
    if (e && e.hiddenFor.length >= 2 && now - c.endedAt > REJOIN_WINDOW_MS) deleteConversation(tx, c.id);
  }
}

export function deleteConversation(tx: Tx, conversationId: string) {
  tx.db.conversations.id.delete(conversationId);
  tx.db.encounters.conversationId.delete(conversationId);
  for (const r of [...tx.db.recordingConsents.conversationId.filter(conversationId)]) tx.db.recordingConsents.id.delete(r.id);
}

// California mode ---------------------------------------------------------------

/**
 * Recording needs both people's yes when either of them has California mode
 * on. `mine` and `theirs` are undefined until that person answers.
 */
export function consentState(tx: Tx, c: Conversation, me: string) {
  const peer = c.a === me ? c.b : c.a;
  const required = Boolean(tx.db.users.id.find(me)?.californiaMode) || Boolean(tx.db.users.id.find(peer)?.californiaMode);
  const mine = tx.db.recordingConsents.id.find(`${c.id}|${me}`)?.agree;
  const theirs = tx.db.recordingConsents.id.find(`${c.id}|${peer}`)?.agree;
  return { required, mine, theirs, allowed: !required || (mine === true && theirs === true) };
}

/** conversations:consent  {conversationId, userId, agree}: my answer to "record this conversation?" */
export function consent({ tx }: Ctx, args: Record<string, unknown>) {
  const conversationId = str(args, "conversationId");
  const userId = str(args, "userId");
  if (typeof args.agree !== "boolean") throw new ArgError("Argument agree must be a boolean");
  const c = tx.db.conversations.id.find(conversationId);
  if (!c || (c.a !== userId && c.b !== userId)) return null;
  const id = `${conversationId}|${userId}`;
  const row = { id, conversationId, userId, agree: args.agree, at: nowMs(tx) };
  if (tx.db.recordingConsents.id.find(id)) tx.db.recordingConsents.id.update(row);
  else tx.db.recordingConsents.insert(row);
  return null;
}
