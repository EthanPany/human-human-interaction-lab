import { avatarOf } from "../lib/avatar";
import {
  GROUP_LEAVE_GRACE_MS,
  MAX_GROUP_SIZE,
  MIN_GROUP_SIZE,
  PART_OVERLAP_SHARE,
  PROXIMITY_FRESH_MS,
  REJOIN_WINDOW_MS,
  TALK_AFTER_MS,
} from "../lib/constants";
import { after, connectionOf, conversationsOf, isMatchPair, log, nowMs, otherOf, pairColor, pairKey, proximityOf } from "../lib/db";
import type { Conversation, EncounterMember, Tx } from "../schema";
import { createEncounter, encounterOf, endConversation, hiddenFrom, reopenEncounter, togetherMs } from "./conversations";
import { str, type Ctx } from "./context";
import { queueFollowUp } from "./followUp";
import { profilePhotoIdOf } from "./profilePhoto";

/**
 * Group encounters: three or more badge wearers together share one encounter.
 *
 * The together graph: two people are linked when their pair is within 1 m
 * (the pair's proximity row is "close", nearby.ts) and has been for a second,
 * or is still close and both are already in the same encounter (they leave
 * only past 1.5 m). Everyone connected to someone in it is in the group. So a
 * group forms when every member is within 1 m of at least one other member and
 * the group is connected; a pair is just a group of two.
 *
 * - People joining an open encounter join it: a pair becomes a group and keeps
 *   its record, start time and transcript.
 * - Someone with nobody in reach for GROUP_LEAVE_GRACE_MS leaves; the rest go
 *   on in the same encounter. Fewer than two left: it ends (conversations.ts).
 * - Two encounters that walk into each other: the one with more people in the
 *   meeting (then the older) keeps going and the others move over.
 * - A group that splits: the larger part keeps the encounter, the other part
 *   starts its own (or rejoins one it left less than 5 minutes ago).
 * - Rejoin and "Drop short encounters" are per person: coming back within 5
 *   minutes after leaving continues the same encounter, and each person's own
 *   time in it decides whether it is dropped for them.
 * - One phone records a group (encounter_recorders): the one standing closest
 *   to the most members, kept while it is there. Pairs record on both phones.
 */

const memberKey = (conversationId: string, userId: string) => `${conversationId}|${userId}`;

// Members ------------------------------------------------------------------------

export function memberRows(tx: Tx, conversationId: string) {
  return [...tx.db.encounterMembers.conversationId.filter(conversationId)];
}

export function memberOf(tx: Tx, c: Conversation, userId: string) {
  return tx.db.encounterMembers.id.find(memberKey(c.id, userId));
}

/** Everyone who was part of the encounter, first joined first (reads only: pairs from before groups are their a and b). */
export function memberIdsOf(tx: Tx, c: Conversation) {
  const rows = memberRows(tx, c.id);
  if (rows.length === 0) return [c.a, c.b];
  return rows.sort((x, y) => x.joinedAt - y.joinedAt || (x.userId < y.userId ? -1 : 1)).map((m) => m.userId);
}

export function isMember(tx: Tx, c: Conversation, userId: string) {
  const rows = memberRows(tx, c.id);
  return rows.length ? rows.some((m) => m.userId === userId) : c.a === userId || c.b === userId;
}

/** Three or more people were part of it. */
export function isGroupEncounter(tx: Tx, c: Conversation) {
  return memberRows(tx, c.id).length >= MIN_GROUP_SIZE;
}

/** The people this person was with in the encounter, first joined first. */
export function companionsOf(tx: Tx, c: Conversation, userId: string) {
  const mine = memberOf(tx, c, userId);
  const ids = memberIdsOf(tx, c).filter((u) => u !== userId);
  return mine ? ids.filter((u) => mine.companions.includes(u)) : ids;
}

/** Member rows for an encounter from before groups (its pair). */
export function ensureMembers(tx: Tx, c: Conversation): EncounterMember[] {
  const rows = memberRows(tx, c.id);
  if (rows.length) return rows;
  const e = encounterOf(tx, c);
  const open = c.endedAt === undefined;
  for (const u of [c.a, c.b]) {
    const row: EncounterMember = {
      id: memberKey(c.id, u),
      conversationId: c.id,
      userId: u,
      joinedAt: c.startedAt,
      presentSince: open ? e.segmentStartedAt : undefined,
      lastTogetherAt: c.endedAt ?? nowMs(tx),
      leftAt: c.endedAt,
      activeMs: e.activeMs,
      companions: [otherOf(c, u)],
      followUp: c.a === u ? c.followUpForA : c.followUpForB,
    };
    tx.db.encounterMembers.insert(row);
    rows.push(row);
  }
  return rows;
}

export function presentMembers(tx: Tx, c: Conversation) {
  return ensureMembers(tx, c).filter((m) => m.presentSince !== undefined);
}

/** Present member ids without writing anything (badge reads). */
export function presentIdsOf(tx: Tx, c: Conversation) {
  const rows = memberRows(tx, c.id);
  if (rows.length === 0) return c.endedAt === undefined ? [c.a, c.b] : [];
  return rows.filter((m) => m.presentSince !== undefined).map((m) => m.userId);
}

/** The open encounter this person is in right now, if any. */
export function openEncounterOf(tx: Tx, userId: string): Conversation | null {
  for (const m of tx.db.encounterMembers.userId.filter(userId)) {
    if (m.presentSince === undefined) continue;
    const c = tx.db.conversations.id.find(m.conversationId);
    if (c && c.endedAt === undefined) return c;
  }
  // From before groups: an open pair conversation without member rows
  for (const c of conversationsOf(tx, userId)) {
    if (c.endedAt === undefined && memberRows(tx, c.id).length === 0) return c;
  }
  return null;
}

/** Both are in the same open encounter right now. */
export function togetherNow(tx: Tx, x: string, y: string) {
  const c = openEncounterOf(tx, x);
  return c !== null && presentIdsOf(tx, c).includes(y);
}

/** Every encounter these two shared (were in it together at some point), any order. */
export function encountersTogether(tx: Tx, userId: string, otherId: string) {
  const out = new Map<string, Conversation>();
  for (const c of tx.db.conversations.pair.filter(pairKey(userId, otherId))) out.set(c.id, c);
  for (const m of tx.db.encounterMembers.userId.filter(userId)) {
    if (!m.companions.includes(otherId) || out.has(m.conversationId)) continue;
    const c = tx.db.conversations.id.find(m.conversationId);
    if (c) out.set(c.id, c);
  }
  return [...out.values()];
}

/** Everyone I was in a group encounter with that I can see (for the People list), with when it started. */
export function groupMatesOf(tx: Tx, userId: string) {
  const out: { id: string; at: number }[] = [];
  for (const m of tx.db.encounterMembers.userId.filter(userId)) {
    const c = tx.db.conversations.id.find(m.conversationId);
    if (!c || hiddenFrom(tx, c, userId)) continue;
    for (const other of m.companions) out.push({ id: other, at: c.startedAt });
  }
  return out;
}

/** Every encounter this person can see, newest first, with the people they were with. */
export function encountersOfUser(tx: Tx, userId: string) {
  const byId = new Map<string, Conversation>();
  for (const c of conversationsOf(tx, userId)) byId.set(c.id, c);
  for (const m of tx.db.encounterMembers.userId.filter(userId)) {
    const c = tx.db.conversations.id.find(m.conversationId);
    if (c) byId.set(c.id, c);
  }
  return [...byId.values()]
    .filter((c) => !hiddenFrom(tx, c, userId))
    .sort((x, y) => y.startedAt - x.startedAt)
    .map((c) => ({ c, others: companionsOf(tx, c, userId) }));
}

/** My own time in the encounter so far (milliseconds). Pairs: the encounter's time together. */
export function myTogetherMs(tx: Tx, c: Conversation, userId: string) {
  const m = memberOf(tx, c, userId);
  if (!m || !isGroupEncounter(tx, c)) return togetherMs(tx, c);
  return m.activeMs + (m.presentSince !== undefined ? Math.max(0, nowMs(tx) - m.presentSince) : 0);
}

// The together graph -----------------------------------------------------------------

/** This person's pair rows that are close (within 1 m, or still under 1.5 m once together) and fresh. */
function closeRows(tx: Tx, userId: string, now: number) {
  return proximityOf(tx, userId).filter((r) => r.closeSince !== undefined && now - r.at < PROXIMITY_FRESH_MS);
}

/**
 * Everyone connected to `seed` right now: a pair links when it has been close
 * for TALK_AFTER_MS, or is close and both are already in the same encounter.
 */
function componentOf(tx: Tx, seed: string, now: number) {
  const memo = new Map<string, string | undefined>();
  const openOf = (u: string) => {
    if (!memo.has(u)) memo.set(u, openEncounterOf(tx, u)?.id);
    return memo.get(u);
  };
  const seen = new Set([seed]);
  const queue = [seed];
  while (queue.length && seen.size < MAX_GROUP_SIZE) {
    const u = queue.shift()!;
    for (const r of closeRows(tx, u, now)) {
      const o = otherOf(r, u);
      if (seen.has(o)) continue;
      const held = now - (r.closeSince ?? now) >= TALK_AFTER_MS;
      const same = !held && openOf(u) !== undefined && openOf(u) === openOf(o) && presentHere(tx, openOf(u)!, o) && presentHere(tx, openOf(u)!, u);
      if (!held && !same) continue;
      seen.add(o);
      queue.push(o);
      if (seen.size >= MAX_GROUP_SIZE) break;
    }
  }
  return [...seen].sort();
}

function presentHere(tx: Tx, conversationId: string, userId: string) {
  const m = tx.db.encounterMembers.id.find(memberKey(conversationId, userId));
  return m ? m.presentSince !== undefined : true; // pairs from before groups: both present while open
}

/**
 * Bring encounters in line with who stands together now, starting from these
 * people (the two phones of a new reading, someone whose badge went off, a
 * badge poll). Changes ripple to the other members of the encounters touched.
 */
export function reconcile(tx: Tx, seeds: string[], now = nowMs(tx)) {
  const done = new Set<string>();
  const queue = [...seeds];
  for (let guard = 0; queue.length && guard < 4 * MAX_GROUP_SIZE; guard++) {
    const seed = queue.shift()!;
    if (done.has(seed)) continue;
    const group = componentOf(tx, seed, now);
    for (const u of group) done.add(u);
    for (const u of settle(tx, group, now)) if (!done.has(u)) queue.push(u);
  }
}

/** Apply one connected group of people. Returns people whose encounter changed and should be looked at too. */
function settle(tx: Tx, group: string[], now: number): string[] {
  if (group.length < 2) {
    const u = group[0];
    const c = openEncounterOf(tx, u);
    if (!c) return [];
    const m = ensureMembers(tx, c).find((r) => r.userId === u);
    if (!m || m.presentSince === undefined) return [];
    if (now - m.lastTogetherAt < GROUP_LEAVE_GRACE_MS) return []; // a moment out of reach: still with them
    const rest = presentMembers(tx, c).filter((r) => r.userId !== u).map((r) => r.userId);
    leave(tx, c, u, now);
    return rest;
  }

  const inGroup = new Set(group);
  const opens = new Map<string, Conversation>();
  for (const u of group) {
    const c = openEncounterOf(tx, u);
    if (c) opens.set(c.id, c);
  }
  const ranked = [...opens.values()]
    .map((c) => {
      const present = presentMembers(tx, c).map((m) => m.userId);
      return { c, present, inside: present.filter((u) => inGroup.has(u)).length };
    })
    .sort((x, y) => y.inside - x.inside || x.c.startedAt - y.c.startedAt || (x.c.id < y.c.id ? -1 : 1));

  // The encounter this group continues: the larger part of a split keeps it
  // (a tie goes to the part with whoever has been there longest).
  let primary: Conversation | null = null;
  for (const { c, present, inside } of ranked) {
    const outside = present.length - inside;
    if (outside > inside) continue;
    if (outside > 0 && outside === inside && !inGroup.has(longestPresent(tx, c))) continue;
    primary = c;
    break;
  }

  const recheck: string[] = [];
  // Everyone here who is still in another open encounter moves over (it goes on, or ends, without them)
  for (const { c } of ranked) {
    if (primary && c.id === primary.id) continue;
    for (const u of group) leave(tx, c, u, now);
    const after = tx.db.conversations.id.find(c.id);
    if (after && after.endedAt === undefined) for (const m of presentMembers(tx, after)) recheck.push(m.userId);
  }

  const matched = anyMatch(tx, group);
  if (!primary) {
    const back = rejoinable(tx, group, now);
    primary = back ? reopenEncounter(tx, back, matched) : createEncounter(tx, group[0], group[1], matched);
  }
  join(tx, primary, group, now, matched);
  for (const m of presentMembers(tx, primary)) if (!inGroup.has(m.userId)) recheck.push(m.userId);
  ensureRecorder(tx, primary, now);
  return recheck;
}

/** Whoever has been with the encounter the longest right now. */
function longestPresent(tx: Tx, c: Conversation) {
  const present = presentMembers(tx, c).sort((x, y) => (x.presentSince ?? 0) - (y.presentSince ?? 0) || (x.userId < y.userId ? -1 : 1));
  return present[0]?.userId;
}

function anyMatch(tx: Tx, group: string[]) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) if (isMatchPair(tx, group[i], group[j])) return true;
  }
  return false;
}

/**
 * An encounter at least two of these people left less than REJOIN_WINDOW_MS
 * ago and that has ended: coming back continues it. The most people back,
 * then the latest.
 */
function rejoinable(tx: Tx, group: string[], now: number) {
  const counts = new Map<string, { c: Conversation; n: number }>();
  const bump = (c: Conversation) => {
    const seen = counts.get(c.id);
    counts.set(c.id, { c, n: (seen?.n ?? 0) + 1 });
  };
  for (const u of group) {
    for (const m of tx.db.encounterMembers.userId.filter(u)) {
      if (m.presentSince !== undefined || m.leftAt === undefined || now - m.leftAt > REJOIN_WINDOW_MS) continue;
      const c = tx.db.conversations.id.find(m.conversationId);
      if (c && c.endedAt !== undefined) bump(c);
    }
    // From before groups
    for (const c of conversationsOf(tx, u)) {
      if (c.endedAt !== undefined && now - c.endedAt <= REJOIN_WINDOW_MS && memberRows(tx, c.id).length === 0) bump(c);
    }
  }
  let best: { c: Conversation; n: number } | undefined;
  for (const x of counts.values()) {
    if (x.n < 2) continue;
    if (!best || x.n > best.n || (x.n === best.n && (x.c.endedAt ?? 0) > (best.c.endedAt ?? 0))) best = x;
  }
  return best?.c ?? null;
}

/** These people are with the encounter now: newcomers join, people back within the window rejoin. */
function join(tx: Tx, c: Conversation, group: string[], now: number, matched: boolean) {
  ensureMembers(tx, c);
  const newcomers: string[] = [];
  for (const u of group) {
    const m = memberOf(tx, c, u);
    if (!m) {
      tx.db.encounterMembers.insert({
        id: memberKey(c.id, u),
        conversationId: c.id,
        userId: u,
        joinedAt: now,
        presentSince: now,
        lastTogetherAt: now,
        leftAt: undefined,
        activeMs: 0,
        companions: [],
        followUp: undefined,
      });
      newcomers.push(u);
    } else if (m.presentSince === undefined) {
      tx.db.encounterMembers.id.update({ ...m, presentSince: now, leftAt: undefined, lastTogetherAt: now });
    } else if (now - m.lastTogetherAt >= 500) {
      tx.db.encounterMembers.id.update({ ...m, lastTogetherAt: now });
    }
  }
  // Everyone present now was with everyone else present
  const present = presentMembers(tx, c);
  const ids = present.map((m) => m.userId);
  for (const m of present) {
    const add = ids.filter((u) => u !== m.userId && !m.companions.includes(u));
    if (add.length) tx.db.encounterMembers.id.update({ ...m, companions: [...m.companions, ...add] });
  }
  const e = encounterOf(tx, c);
  if (matched && !e.matched) tx.db.encounters.conversationId.update({ ...e, matched: true });
  // Joining someone's encounter: one "Talked with" line each way (the founding pair has theirs)
  if (newcomers.length && memberRows(tx, c.id).length > 2) {
    for (const u of newcomers) {
      const me = tx.db.users.id.find(u);
      for (const other of ids) {
        if (other === u || (newcomers.includes(other) && other < u)) continue;
        const them = tx.db.users.id.find(other);
        log(tx, u, other, "talked", `Talked with ${them?.name ?? "them"} in a group`);
        log(tx, other, u, "talked", `Talked with ${me?.name ?? "them"} in a group`);
      }
    }
  }
}

/** This person leaves the encounter. The rest go on; fewer than two left, it ends. */
export function leave(tx: Tx, c: Conversation, userId: string, now = nowMs(tx)) {
  const m = ensureMembers(tx, c).find((r) => r.userId === userId);
  if (!m || m.presentSince === undefined) return;
  tx.db.encounterMembers.id.update({
    ...m,
    presentSince: undefined,
    leftAt: now,
    activeMs: m.activeMs + Math.max(0, now - m.presentSince),
  });
  if (presentMembers(tx, c).length < 2) {
    endConversation(tx, c.id);
    return;
  }
  // The group goes on without them: their follow up waits for it (followUp.ts)
  queueFollowUp(tx, c.id, userId);
  ensureRecorder(tx, c, now);
}

// Recording ---------------------------------------------------------------------------

function recordsConversations(tx: Tx, userId: string) {
  return tx.db.users.id.find(userId)?.recordConversations !== false;
}

/**
 * The one phone that records a group: kept while it is there and records;
 * otherwise whoever stands within reach of the most members (best placed to
 * hear everyone), then whoever has been there longest.
 */
export function ensureRecorder(tx: Tx, c: Conversation, now = nowMs(tx)) {
  const present = presentMembers(tx, c);
  const current = tx.db.encounterRecorders.conversationId.find(c.id);
  // A pair records on both phones; the recorder is picked when a group forms
  if (present.length < MIN_GROUP_SIZE) {
    if (current) tx.db.encounterRecorders.conversationId.delete(c.id);
    return undefined;
  }
  if (current && present.some((m) => m.userId === current.userId) && recordsConversations(tx, current.userId)) return current.userId;
  const ids = new Set(present.map((m) => m.userId));
  const reach = (u: string) => closeRows(tx, u, now).filter((r) => ids.has(otherOf(r, u))).length;
  const candidates = present
    .filter((m) => recordsConversations(tx, m.userId))
    .sort((x, y) => reach(y.userId) - reach(x.userId) || (x.presentSince ?? 0) - (y.presentSince ?? 0) || (x.userId < y.userId ? -1 : 1));
  const pick = candidates[0]?.userId;
  if (!pick) {
    if (current) tx.db.encounterRecorders.conversationId.delete(c.id);
    return undefined;
  }
  const row = { conversationId: c.id, userId: pick, since: now };
  if (current) tx.db.encounterRecorders.conversationId.update(row);
  else tx.db.encounterRecorders.insert(row);
  return pick;
}

/** This phone should record: a pair records on both phones; a group (three or more here) only on its recorder. */
export function recordsHere(tx: Tx, c: Conversation, userId: string) {
  if (presentIdsOf(tx, c).length < MIN_GROUP_SIZE) return true;
  return tx.db.encounterRecorders.conversationId.find(c.id)?.userId === userId;
}

// Transcripts -----------------------------------------------------------------------

/** Store what one phone recorded. The same phone sending the same piece again: the longer text counts. */
export function storePart(tx: Tx, c: Conversation, userId: string, startedAt: number, endedAt: number, text: string) {
  const now = nowMs(tx);
  const parts = [...tx.db.transcriptParts.conversationId.filter(c.id)];
  // A transcript from before pieces existed: keep it as the first piece
  if (parts.length === 0 && c.transcript?.trim()) {
    tx.db.transcriptParts.insert({
      id: memberKey(c.id, "earlier") + "|0",
      conversationId: c.id,
      userId: "earlier",
      startedAt: c.startedAt,
      endedAt: c.endedAt ?? c.startedAt,
      text: c.transcript,
      at: now,
    });
  }
  const id = `${c.id}|${userId}|${Math.round(startedAt)}`;
  const found = tx.db.transcriptParts.id.find(id);
  if (found) {
    if (text.length > found.text.length || endedAt > found.endedAt) {
      tx.db.transcriptParts.id.update({
        ...found,
        text: text.length >= found.text.length ? text : found.text,
        endedAt: Math.max(endedAt, found.endedAt),
        at: now,
      });
    }
    return;
  }
  tx.db.transcriptParts.insert({ id, conversationId: c.id, userId, startedAt, endedAt: Math.max(endedAt, startedAt), text, at: now });
}

/**
 * The encounter's transcript from every piece: pieces that cover mostly the
 * same time are the same talk heard by several phones (the longer one counts),
 * the rest are joined in time order (the recorder changed).
 */
export function mergedTranscript(tx: Tx, conversationId: string) {
  const parts = [...tx.db.transcriptParts.conversationId.filter(conversationId)].sort((x, y) => x.startedAt - y.startedAt);
  if (parts.length === 0) return undefined;
  const span = (p: (typeof parts)[number]) => Math.max(1_000, p.endedAt - p.startedAt);
  const kept: typeof parts = [];
  for (const p of parts) {
    const dup = kept.findIndex((q) => {
      const overlap = Math.min(p.endedAt, q.endedAt) - Math.max(p.startedAt, q.startedAt);
      return overlap >= PART_OVERLAP_SHARE * Math.min(span(p), span(q)) || (p.startedAt === q.startedAt && p.userId !== q.userId);
    });
    if (dup < 0) kept.push(p);
    else if (p.text.trim().length > kept[dup].text.trim().length) kept[dup] = p;
  }
  const text = kept
    .sort((x, y) => x.startedAt - y.startedAt)
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

/**
 * Write the merged transcript on the encounter. A piece that arrives after the
 * encounter ended (a phone uploads late) summarizes it again.
 */
export function refreshTranscript(tx: Tx, conversationId: string) {
  const c = tx.db.conversations.id.find(conversationId);
  if (!c) return;
  const text = mergedTranscript(tx, conversationId);
  if (text === undefined || text === c.transcript) return;
  tx.db.conversations.id.update({ ...c, transcript: text });
  const e = tx.db.encounters.conversationId.find(c.id);
  const kept = !e || e.hiddenFor.length < Math.max(2, memberRows(tx, c.id).length);
  if (c.endedAt !== undefined && kept) {
    tx.db.summarizeJob.insert({ scheduledId: 0n, scheduledAt: after(tx, 8_000), conversationId: c.id });
  }
}

// Text helpers --------------------------------------------------------------------------

/** "Maya", "Maya and Leo", "Maya, Leo and Sam", "Maya, Leo, Sam and 2 others". */
export function joinNames(names: string[]) {
  const list = names.map((n) => n || "someone");
  if (list.length <= 1) return list[0] ?? "them";
  if (list.length <= 4) return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  const rest = list.length - 3;
  return `${list.slice(0, 3).join(", ")} and ${rest} others`;
}

/** First names of these people, in order. */
export function firstNames(tx: Tx, ids: string[]) {
  return ids.map((id) => (tx.db.users.id.find(id)?.name ?? "someone").split(/\s+/)[0]);
}

// Routes ---------------------------------------------------------------------------------

function personView(ctx: Ctx, userId: string) {
  const u = ctx.tx.db.users.id.find(userId);
  if (!u) return null;
  const avatar = avatarOf({ _id: u.id, avatarShape: u.avatarShape, avatarColor: u.avatarColor });
  return {
    id: u.id,
    name: u.name,
    headline: u.headline,
    company: u.company,
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    profilePhotoUrl: ctx.photoUrl(profilePhotoIdOf(ctx.tx, u.id)),
  };
}

/** A few lines from the transcript when there is no Claude highlight. */
function fallbackHighlights(transcript: string | undefined) {
  if (!transcript) return [];
  return transcript
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
    .slice(0, 3)
    .map((s) => (s.length > 160 ? `${s.slice(0, 157)}...` : s));
}

function groupRow(ctx: Ctx, c: Conversation, userId: string) {
  const { tx } = ctx;
  const others = companionsOf(tx, c, userId);
  const present = new Set(c.endedAt === undefined ? presentIdsOf(tx, c) : []);
  return {
    id: c.id,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    durationMs: togetherMs(tx, c),
    myDurationMs: myTogetherMs(tx, c, userId),
    summary: c.summary,
    topics: c.topics ?? [],
    memberCount: others.length + 1,
    members: others
      .map((id) => {
        const p = personView(ctx, id);
        return p ? { ...p, present: present.has(id) } : null;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null),
  };
}

/**
 * groups:list {userId}: my group encounters (three or more people), newest
 * first, for the People list: when, how long, the summary and the others.
 */
export function list(ctx: Ctx, args: Record<string, unknown>) {
  const { tx } = ctx;
  const userId = str(args, "userId");
  const out = [];
  for (const m of tx.db.encounterMembers.userId.filter(userId)) {
    const c = tx.db.conversations.id.find(m.conversationId);
    if (!c || !isGroupEncounter(tx, c) || hiddenFrom(tx, c, userId)) continue;
    if (companionsOf(tx, c, userId).length < 2) continue; // I was only ever with one of them: a pair to me
    out.push(groupRow(ctx, c, userId));
  }
  return out.sort((x, y) => y.startedAt - x.startedAt);
}

/**
 * groups:detail {userId, conversationId}: one group encounter: the summary,
 * a few highlights from the transcript, my follow up, and each member (when
 * they joined and left, whether we matched, whether I saved them).
 */
export function detail(ctx: Ctx, args: Record<string, unknown>) {
  const { tx } = ctx;
  const userId = str(args, "userId");
  const c = tx.db.conversations.id.find(str(args, "conversationId"));
  if (!c || !isMember(tx, c, userId) || hiddenFrom(tx, c, userId)) return null;
  const row = groupRow(ctx, c, userId);
  const extra = tx.db.groupSummaries.conversationId.find(c.id);
  const mine = memberOf(tx, c, userId);
  const rows = new Map(memberRows(tx, c.id).map((m) => [m.userId, m]));
  return {
    ...row,
    followUp: mine?.followUp ?? (c.a === userId ? c.followUpForA : c.followUpForB),
    highlights: extra?.highlights.length ? extra.highlights : fallbackHighlights(c.transcript),
    hasTranscript: Boolean(c.transcript?.trim()),
    members: row.members.map((p) => {
      const m = rows.get(p.id);
      return {
        ...p,
        joinedAt: m?.joinedAt,
        leftAt: m?.presentSince !== undefined ? undefined : m?.leftAt,
        matched: isMatchPair(tx, userId, p.id),
        color: isMatchPair(tx, userId, p.id) ? pairColor(userId, p.id) : undefined,
        saved: Boolean(connectionOf(tx, userId, p.id)),
      };
    }),
  };
}

/** For people:detail: an encounter's group facts as seen from my side, on a person's page. */
export function groupFacts(ctx: Ctx, c: Conversation, userId: string, subjectId: string) {
  const { tx } = ctx;
  const group = isGroupEncounter(tx, c);
  if (!group) return { group: false, others: [] as ReturnType<typeof personView>[] };
  const others = companionsOf(tx, c, userId)
    .filter((id) => id !== subjectId)
    .map((id) => personView(ctx, id))
    .filter((p): p is NonNullable<typeof p> => p !== null);
  return {
    group: true,
    others,
    durationMs: myTogetherMs(tx, c, userId),
    followUp: memberOf(tx, c, userId)?.followUp,
  };
}
