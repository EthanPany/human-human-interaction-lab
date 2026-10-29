import { avatarOf } from "../lib/avatar";
import { closenessAt, GROUP_LEAVE_GRACE_MS, MIN_GROUP_SIZE, PROXIMITY_FRESH_MS, TALK_DISTANCE_M } from "../lib/constants";
import { connectionOf, loadRubric, matchOf, nowMs, otherOf, pairColor, pairKey, pairRangeM, proximityOf, respondFromOf } from "../lib/db";
import type { Conversation, Tx } from "../schema";
import { consentState } from "./conversations";
import { ensureRecorder, memberOf, openEncounterOf, presentIdsOf, reconcile, recordsHere } from "./groups";
import { distanceSourceOf } from "./nearby";
import { str, type Ctx } from "./context";

/**
 * Port of backend/convex/badge.ts: everything the worn badge needs.
 * On Convex this is a live query; here the app polls it about once a second.
 *
 * Two kinds of peer show up:
 * - a match within the pair's respond range (`matched`): tint, glow and the
 *   approach cues, growing from the respond range down to talking distance;
 * - anyone I'm in an encounter with (together within 1 m), match or not: the
 *   avatars join and recording can start, but a non match gets no tint.
 *
 * In a group (three or more together, groups.ts) `members` lists everyone
 * else in it, first joined first, each with `matched` and the pair `color`
 * for matches only (the badge blends only matched colors), and whether they
 * answered the recording question. The peer fields name the member I'm most
 * connected to (best match first), for older apps. One phone records a group:
 * `isRecorder`, and `recordingAllowed` is true only there.
 */
export function state({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const me = tx.db.users.id.find(userId);
  const base = {
    mode: "idle" as "idle" | "match" | "talking" | "connected",
    matched: false,
    glow: 0,
    color: undefined as string | undefined,
    frontTag: undefined as string | undefined,
    peerId: undefined as string | undefined,
    peerName: undefined as string | undefined,
    peerAvatarShape: undefined as string | undefined,
    peerAvatarColor: undefined as string | undefined,
    closeness: 0,
    /**
     * The pair's distance merged from both phones (nearby.ts): either side
     * seeing the other is enough. `distanceSource` is uwb, or ble for a coarse
     * Bluetooth estimate; `estimated` means Bluetooth alone says together.
     */
    meters: undefined as number | undefined,
    distanceAgeMs: undefined as number | undefined,
    distanceSource: undefined as "uwb" | "ble" | undefined,
    estimated: false,
    /** Where this pair's badges start reacting (meters); mine alone when nobody is near. */
    respondRangeM: me ? respondFromOf(tx, userId) : undefined as number | undefined,
    conversationId: undefined as string | undefined,
    recordConversations: me?.recordConversations ?? true,
    californiaMode: me?.californiaMode ?? false,
    /** Either of us has California mode on: recording waits for both yeses. */
    consentRequired: false,
    myConsent: undefined as boolean | undefined,
    peerConsent: undefined as boolean | undefined,
    /** This phone may record now (both agreed, or no consent needed). */
    recordingAllowed: false,
    /** Three or more together right now (one shared encounter). */
    group: false,
    /** Everyone else in my encounter right now, first joined first (pairs too). */
    members: [] as GroupMemberView[],
    /** This phone is the one recording the encounter (pairs: both phones). */
    isRecorder: false,
  };
  if (!me) return base;

  const now = nowMs(tx);
  const rubric = loadRubric(tx);

  // In an encounter right now: everyone in it joins the badge.
  let open = openEncounterOf(tx, userId);
  if (open) {
    const mine = memberOf(tx, open, userId);
    // Nobody refreshed my place in it for a while (readings stopped): check now
    if (mine && now - mine.lastTogetherAt > GROUP_LEAVE_GRACE_MS / 2) {
      reconcile(tx, [userId], now);
      open = openEncounterOf(tx, userId);
    }
  }
  if (open) return { ...base, ...encounterState(tx, open, userId, now, rubric.threshold) };

  const rows = proximityOf(tx, userId).filter((r) => now - r.at < PROXIMITY_FRESH_MS);

  let best: { rank: number; row: (typeof rows)[number]; matched: boolean; rangeM: number } | undefined;
  for (const row of rows) {
    const peer = otherOf(row, userId);
    const score = Math.max(matchOf(tx, userId, peer)?.score ?? 0, matchOf(tx, peer, userId)?.score ?? 0);
    const matched = score >= rubric.threshold;
    const rangeM = pairRangeM(tx, userId, peer);
    // (The people I'm together with are handled above: someone walking by can't interrupt.)
    let rank: number;
    if (matched && row.meters <= rangeM) rank = score * (0.3 + 0.7 * closenessAt(row.meters, rangeM));
    else continue;
    if (!best || rank > best.rank) best = { rank, row, matched, rangeM };
  }
  if (!best) return base;

  const peerId = otherOf(best.row, userId);
  const peer = tx.db.users.id.find(peerId);
  const theirView = matchOf(tx, peerId, userId);
  const connection = connectionOf(tx, userId, peerId);
  const closeness = closenessAt(best.row.meters, best.rangeM);
  const source = distanceSourceOf(tx, best.row);
  const peerAvatar = peer ? avatarOf({ _id: peer.id, avatarShape: peer.avatarShape, avatarColor: peer.avatarColor }) : undefined;
  return {
    ...base,
    mode: connection ? "connected" : "match",
    matched: best.matched,
    glow: best.matched ? 0.25 + 0.75 * closeness : 0,
    color: best.matched ? pairColor(userId, peerId) : undefined,
    frontTag: best.matched ? theirView?.tag : undefined,
    peerId,
    peerName: peer?.name,
    peerAvatarShape: peerAvatar?.shape,
    peerAvatarColor: peerAvatar?.color,
    closeness,
    meters: best.row.meters,
    distanceAgeMs: now - best.row.at,
    distanceSource: source,
    estimated: false,
    respondRangeM: best.rangeM,
  };
}

type GroupMemberView = {
  id: string;
  name?: string;
  avatarShape: string;
  avatarColor: string;
  matched: boolean;
  color?: string;
  joinedAt: number;
  consent?: boolean;
};

/**
 * The badge while I'm in an encounter: talking, everyone in it, the pair
 * fields for the member I'm most connected to, consent from everyone there,
 * and whether this phone records.
 */
function encounterState(tx: Tx, c: Conversation, userId: string, now: number, threshold: number) {
  const present = presentIdsOf(tx, c).filter((u) => u !== userId);
  const consent = consentState(tx, c, userId);
  const score = (u: string) => Math.max(matchOf(tx, userId, u)?.score ?? 0, matchOf(tx, u, userId)?.score ?? 0);
  const rowWith = (u: string) => {
    const r = tx.db.proximity.id.find(pairKey(userId, u));
    return r && now - r.at < PROXIMITY_FRESH_MS ? r : undefined;
  };
  const members: GroupMemberView[] = present
    .map((u) => {
      const p = tx.db.users.id.find(u);
      const avatar = avatarOf({ _id: u, avatarShape: p?.avatarShape, avatarColor: p?.avatarColor });
      const matched = score(u) >= threshold;
      return {
        id: u,
        name: p?.name,
        avatarShape: avatar.shape,
        avatarColor: avatar.color,
        matched,
        color: matched ? pairColor(userId, u) : undefined,
        joinedAt: memberOf(tx, c, u)?.joinedAt ?? c.startedAt,
        consent: consent.answer(u),
      };
    })
    .sort((x, y) => x.joinedAt - y.joinedAt || (x.id < y.id ? -1 : 1));

  // The member the pair fields describe: someone I'm close to, best match first
  const lead = [...members].sort((x, y) => {
    const near = (m: GroupMemberView) => (rowWith(m.id)?.closeSince !== undefined ? 1 : 0);
    return near(y) - near(x) || Number(y.matched) - Number(x.matched) || score(y.id) - score(x.id) || x.joinedAt - y.joinedAt;
  })[0];
  const peer = lead ? tx.db.users.id.find(lead.id) : undefined;
  const row = lead ? rowWith(lead.id) : undefined;
  const source = row ? distanceSourceOf(tx, row) : undefined;
  const group = present.length + 1 >= MIN_GROUP_SIZE;
  if (group && !tx.db.encounterRecorders.conversationId.find(c.id)) ensureRecorder(tx, c, now);
  const isRecorder = recordsHere(tx, c, userId);
  const anyMatch = members.some((m) => m.matched);
  return {
    mode: "talking" as const,
    matched: anyMatch,
    glow: anyMatch ? 1 : 0,
    color: anyMatch ? (lead?.matched ? lead.color : members.find((m) => m.matched)?.color) : undefined,
    frontTag: lead?.matched ? matchOf(tx, lead.id, userId)?.tag : undefined,
    peerId: lead?.id,
    peerName: peer?.name,
    peerAvatarShape: lead?.avatarShape,
    peerAvatarColor: lead?.avatarColor,
    closeness: 1,
    meters: row?.meters,
    distanceAgeMs: row ? now - row.at : undefined,
    distanceSource: source,
    estimated: source === "ble" && row?.closeSince !== undefined && (row?.meters ?? 99) <= TALK_DISTANCE_M,
    respondRangeM: lead ? pairRangeM(tx, userId, lead.id) : respondFromOf(tx, userId),
    conversationId: c.id,
    consentRequired: consent.required,
    myConsent: consent.mine,
    peerConsent: consent.theirs,
    recordingAllowed: consent.allowed && isRecorder,
    group,
    members,
    isRecorder,
  };
}
