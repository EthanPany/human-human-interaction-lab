import { avatarOf } from "../lib/avatar";
import { closenessAt, PROXIMITY_FRESH_MS } from "../lib/constants";
import {
  connectionOf,
  loadRubric,
  matchOf,
  nowMs,
  openConversationOf,
  otherOf,
  pairColor,
  pairRangeM,
  proximityOf,
  respondFromOf,
} from "../lib/db";
import { consentState } from "./conversations";
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
  };
  if (!me) return base;

  const now = nowMs(tx);
  const rubric = loadRubric(tx);
  const rows = proximityOf(tx, userId).filter((r) => now - r.at < PROXIMITY_FRESH_MS);

  let best: { rank: number; row: (typeof rows)[number]; matched: boolean; rangeM: number } | undefined;
  for (const row of rows) {
    const peer = otherOf(row, userId);
    const score = Math.max(matchOf(tx, userId, peer)?.score ?? 0, matchOf(tx, peer, userId)?.score ?? 0);
    const matched = score >= rubric.threshold;
    const rangeM = pairRangeM(tx, userId, peer);
    // The person I'm together with always wins, so someone walking by can't
    // interrupt (and end) the encounter.
    const inTalk = row.closeSince !== undefined && openConversationOf(tx, row.a, row.b) !== null;
    let rank: number;
    if (inTalk) rank = 10 + (matched ? 1 : 0) + score;
    else if (matched && row.meters <= rangeM) rank = score * (0.3 + 0.7 * closenessAt(row.meters, rangeM));
    else continue;
    if (!best || rank > best.rank) best = { rank, row, matched, rangeM };
  }
  if (!best) return base;

  const peerId = otherOf(best.row, userId);
  const peer = tx.db.users.id.find(peerId);
  const theirView = matchOf(tx, peerId, userId);
  const connection = connectionOf(tx, userId, peerId);
  const open = openConversationOf(tx, best.row.a, best.row.b);

  // An open conversation only exists after they stayed close for TALK_AFTER_MS
  // (nearby.reportDistance), so here it is enough that they are still close.
  const talking = best.row.closeSince !== undefined && open !== null;
  const consent = talking && open ? consentState(tx, open, userId) : undefined;

  const closeness = talking ? 1 : closenessAt(best.row.meters, best.rangeM);
  const peerAvatar = peer ? avatarOf({ _id: peer.id, avatarShape: peer.avatarShape, avatarColor: peer.avatarColor }) : undefined;
  return {
    ...base,
    mode: talking ? "talking" : connection ? "connected" : "match",
    matched: best.matched,
    glow: best.matched ? (talking ? 1 : 0.25 + 0.75 * closeness) : 0,
    color: best.matched ? pairColor(userId, peerId) : undefined,
    frontTag: best.matched ? theirView?.tag : undefined,
    peerId,
    peerName: peer?.name,
    peerAvatarShape: peerAvatar?.shape,
    peerAvatarColor: peerAvatar?.color,
    closeness,
    respondRangeM: best.rangeM,
    conversationId: talking ? open?.id : undefined,
    consentRequired: consent?.required ?? false,
    myConsent: consent?.mine,
    peerConsent: consent?.theirs,
    recordingAllowed: consent?.allowed ?? false,
  };
}
