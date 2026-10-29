import { MIN_ENCOUNTER_MS, REJOIN_WINDOW_MS, STALE_CONVERSATION_MS } from "../lib/constants";
import { after, dropsShortEncounters, log, newId, nowMs, pairKey } from "../lib/db";
import type { Conversation, Encounter, Tx } from "../schema";
import { ArgError, optStr, str, type Ctx } from "./context";
import { queueFollowUp } from "./followUp";
import { ensureMembers, isMember, leave, memberRows, presentIdsOf, presentMembers, reconcile, refreshTranscript, storePart } from "./groups";

/**
 * Port of backend/convex/conversations.ts, with encounters on top.
 *
 * One conversation row is one encounter, of two people or a group: groups.ts
 * decides who is in it (three or more together share one). People who come
 * back within REJOIN_WINDOW_MS after leaving continue the same one (the
 * record and the transcript carry on); later than that is a new encounter
 * with its own summary. "Drop short encounters" hides encounters from whoever
 * has it on (the default) when their own time in it was under
 * MIN_ENCOUNTER_MS; hidden for everyone, the encounter is deleted once it can
 * no longer be rejoined. Summaries run in summarize.ts.
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

/** Time the encounter has been going, over all its segments (milliseconds). */
export function togetherMs(tx: Tx, c: Conversation) {
  const e = tx.db.encounters.conversationId.find(c.id);
  if (!e) return Math.max(0, (c.endedAt ?? nowMs(tx)) - c.startedAt);
  return e.activeMs + (c.endedAt === undefined ? Math.max(0, nowMs(tx) - e.segmentStartedAt) : 0);
}

/** A new encounter for two people (more join through groups.ts). */
export function createEncounter(tx: Tx, x: string, y: string, matched: boolean) {
  const now = nowMs(tx);
  const [a, b] = x < y ? [x, y] : [y, x];
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
  return tx.db.conversations.id.find(id)!;
}

/** People left it less than REJOIN_WINDOW_MS ago and are back: the same encounter goes on (groups.ts). */
export function reopenEncounter(tx: Tx, c: Conversation, matched: boolean) {
  const now = nowMs(tx);
  const e = encounterOf(tx, c);
  ensureMembers(tx, c);
  tx.db.conversations.id.update({ ...c, endedAt: undefined });
  tx.db.encounters.conversationId.update({
    ...e,
    matched: e.matched || matched,
    segmentStartedAt: now,
    priorTranscript: c.transcript,
    segmentTranscript: undefined,
    hiddenFor: [], // decided again when this segment ends
  });
  return tx.db.conversations.id.find(c.id)!;
}

/**
 * conversations:finish {conversationId, transcript?, userId?, startedAt?, leaving?}
 *
 * A phone stopped recording and sends what it heard (`startedAt`: when that
 * recording started). Pieces from several phones are merged (groups.ts): the
 * same time heard twice counts once, pieces one after another are joined.
 * `leaving` (default true) means this person left the encounter; the rest go
 * on, and fewer than two left ends it. Older apps send neither userId nor
 * startedAt: their transcript is one piece for the current segment, and their
 * finish ends a pair encounter as before (a group goes on).
 */
export function finish({ tx }: Ctx, args: Record<string, unknown>) {
  const c = tx.db.conversations.id.find(str(args, "conversationId"));
  if (!c) return null;
  const userId = optStr(args, "userId");
  const transcript = optStr(args, "transcript");
  const startedAt = typeof args.startedAt === "number" && Number.isFinite(args.startedAt) ? args.startedAt : undefined;
  const leaving = args.leaving !== false;
  const now = nowMs(tx);
  const e = encounterOf(tx, c);
  if (transcript?.trim() && (!userId || isMember(tx, c, userId))) {
    storePart(tx, c, userId ?? "phone", Math.min(now, startedAt ?? e.segmentStartedAt), now, transcript);
    refreshTranscript(tx, c.id);
  }
  if (!leaving || c.endedAt !== undefined) return null;
  if (userId) {
    if (isMember(tx, c, userId)) leave(tx, c, userId, now);
  } else if (presentIdsOf(tx, c).length <= 2) {
    endConversation(tx, c.id);
  }
  return null;
}

/**
 * End the encounter (idempotent): everyone still there leaves. Short
 * encounters are hidden from people who drop them, by their own time in it
 * (MIN_ENCOUNTER_MS over all their stretches); everyone else gets the "save
 * their contact?" text once per encounter, and the summary runs after the
 * phones had time to upload.
 */
export function endConversation(tx: Tx, conversationId: string) {
  const c = tx.db.conversations.id.find(conversationId);
  if (!c || c.endedAt !== undefined) return;
  const e = encounterOf(tx, c);
  const now = nowMs(tx);
  for (const m of presentMembers(tx, c)) {
    tx.db.encounterMembers.id.update({
      ...m,
      presentSince: undefined,
      leftAt: now,
      activeMs: m.activeMs + Math.max(0, now - (m.presentSince ?? now)),
    });
  }
  const members = memberRows(tx, c.id);
  const activeMs = e.activeMs + Math.max(0, now - e.segmentStartedAt);
  const hiddenFor = members.filter((m) => m.activeMs < MIN_ENCOUNTER_MS && dropsShortEncounters(tx, m.userId)).map((m) => m.userId);
  // The "Nice meeting ... Save their contact?" text (followUp.ts: once per
  // person, waits for the summary). Dropped encounters get none.
  for (const m of members) if (!hiddenFor.includes(m.userId)) queueFollowUp(tx, c.id, m.userId);

  tx.db.conversations.id.update({ ...c, endedAt: now });
  tx.db.encounters.conversationId.update({ ...e, activeMs, hiddenFor });
  tx.db.encounterRecorders.conversationId.delete(c.id);

  // Dropped for everyone: no summary (closeStale deletes it once it can't be rejoined).
  if (hiddenFor.length < members.length) {
    tx.db.summarizeJob.insert({ scheduledId: 0n, scheduledAt: after(tx, 8_000), conversationId });
  }
}

/**
 * Safety net (every minute): people whose phones stopped reporting or who are
 * no longer close leave their encounter (it ends with fewer than two), in
 * case an app died before calling finish; encounters everyone dropped are
 * deleted once they can no longer be rejoined.
 */
export function closeStale(tx: Tx) {
  const now = nowMs(tx);
  for (const c of [...tx.db.conversations.iter()]) {
    if (c.endedAt === undefined) {
      const segmentStart = tx.db.encounters.conversationId.find(c.id)?.segmentStartedAt ?? c.startedAt;
      if (now - segmentStart < STALE_CONVERSATION_MS) continue;
      reconcile(tx, presentMembers(tx, c).map((m) => m.userId), now);
      continue;
    }
    const e = tx.db.encounters.conversationId.find(c.id);
    const everyone = Math.max(2, memberRows(tx, c.id).length);
    if (e && e.hiddenFor.length >= everyone && now - c.endedAt > REJOIN_WINDOW_MS) deleteConversation(tx, c.id);
  }
}

export function deleteConversation(tx: Tx, conversationId: string) {
  tx.db.conversations.id.delete(conversationId);
  tx.db.encounters.conversationId.delete(conversationId);
  for (const m of memberRows(tx, conversationId)) tx.db.encounterMembers.id.delete(m.id);
  for (const p of [...tx.db.transcriptParts.conversationId.filter(conversationId)]) tx.db.transcriptParts.id.delete(p.id);
  tx.db.encounterRecorders.conversationId.delete(conversationId);
  tx.db.groupSummaries.conversationId.delete(conversationId);
  for (const r of [...tx.db.recordingConsents.conversationId.filter(conversationId)]) tx.db.recordingConsents.id.delete(r.id);
}

// California mode ---------------------------------------------------------------

/**
 * Recording needs everyone's yes when anyone there has California mode on (a
 * pair: both people; a group: every member with it right now, so a newcomer
 * pauses it until they answer). `mine` is undefined until I answer; `theirs`
 * is false when anyone else said no, true when everyone else said yes.
 */
export function consentState(tx: Tx, c: Conversation, me: string) {
  const ids = [...new Set([me, ...(c.endedAt === undefined ? presentIdsOf(tx, c) : [c.a, c.b])])];
  const required = ids.some((u) => Boolean(tx.db.users.id.find(u)?.californiaMode));
  const answer = (u: string) => tx.db.recordingConsents.id.find(`${c.id}|${u}`)?.agree;
  const mine = answer(me);
  const others = ids.filter((u) => u !== me).map(answer);
  const theirs = others.some((a) => a === false) ? false : others.length > 0 && others.every((a) => a === true) ? true : undefined;
  return { required, mine, theirs, allowed: !required || (mine === true && theirs === true), answer };
}

/** conversations:consent  {conversationId, userId, agree}: my answer to "record this conversation?" */
export function consent({ tx }: Ctx, args: Record<string, unknown>) {
  const conversationId = str(args, "conversationId");
  const userId = str(args, "userId");
  if (typeof args.agree !== "boolean") throw new ArgError("Argument agree must be a boolean");
  const c = tx.db.conversations.id.find(conversationId);
  if (!c || !isMember(tx, c, userId)) return null;
  const id = `${conversationId}|${userId}`;
  const row = { id, conversationId, userId, agree: args.agree, at: nowMs(tx) };
  if (tx.db.recordingConsents.id.find(id)) tx.db.recordingConsents.id.update(row);
  else tx.db.recordingConsents.insert(row);
  return null;
}
