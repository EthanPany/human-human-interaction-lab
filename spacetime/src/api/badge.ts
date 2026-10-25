import { avatarOf } from "../lib/avatar";
import { FULL_GLOW_M, GLOW_RANGE_M, PROXIMITY_FRESH_MS } from "../lib/constants";
import { connectionOf, latestConversation, loadRubric, matchOf, nowMs, otherOf, pairColor, proximityOf } from "../lib/db";
import { str, type Ctx } from "./context";

/**
 * Port of backend/convex/badge.ts: everything the worn badge needs.
 * On Convex this is a live query; here the app polls it about once a second.
 */
export function state({ tx }: Ctx, args: Record<string, unknown>) {
  const userId = str(args, "userId");
  const me = tx.db.users.id.find(userId);
  const base = {
    mode: "idle" as "idle" | "match" | "talking" | "connected",
    glow: 0,
    color: undefined as string | undefined,
    frontTag: undefined as string | undefined,
    peerId: undefined as string | undefined,
    peerName: undefined as string | undefined,
    peerAvatarShape: undefined as string | undefined,
    peerAvatarColor: undefined as string | undefined,
    closeness: 0,
    conversationId: undefined as string | undefined,
    recordConversations: me?.recordConversations ?? true,
    californiaMode: me?.californiaMode ?? true,
  };
  if (!me) return base;

  const now = nowMs(tx);
  const rubric = loadRubric(tx);
  const rows = proximityOf(tx, userId).filter((r) => now - r.at < PROXIMITY_FRESH_MS && r.meters <= GLOW_RANGE_M);

  let best: { rank: number; row: (typeof rows)[number]; score: number } | undefined;
  for (const row of rows) {
    // The person I'm talking with always wins, so a stronger match walking by
    // can't interrupt (and end) the conversation.
    const latestTalk = row.closeSince !== undefined ? latestConversation(tx, row.a, row.b) : null;
    const inTalk = latestTalk !== null && latestTalk.endedAt === undefined;
    const peer = otherOf(row, userId);
    const score = Math.max(matchOf(tx, userId, peer)?.score ?? 0, matchOf(tx, peer, userId)?.score ?? 0);
    if (score < rubric.threshold) continue;
    const proximity = Math.max(0, Math.min(1, (GLOW_RANGE_M - row.meters) / (GLOW_RANGE_M - FULL_GLOW_M)));
    const rank = inTalk ? 10 + score : score * (0.3 + 0.7 * proximity);
    if (!best || rank > best.rank) best = { rank, row, score };
  }
  if (!best) return base;

  const peerId = otherOf(best.row, userId);
  const peer = tx.db.users.id.find(peerId);
  const theirView = matchOf(tx, peerId, userId);
  const connection = connectionOf(tx, userId, peerId);
  const openConversation = latestConversation(tx, best.row.a, best.row.b);

  // An open conversation only exists after they stayed close for TALK_AFTER_MS
  // (nearby.reportDistance), so here it is enough that they are still close.
  const talking =
    best.row.closeSince !== undefined &&
    openConversation !== null &&
    openConversation.endedAt === undefined;

  const proximity = Math.max(0, Math.min(1, (GLOW_RANGE_M - best.row.meters) / (GLOW_RANGE_M - FULL_GLOW_M)));
  const peerAvatar = peer ? avatarOf({ _id: peer.id, avatarShape: peer.avatarShape, avatarColor: peer.avatarColor }) : undefined;
  return {
    ...base,
    mode: talking ? "talking" : connection ? "connected" : "match",
    glow: talking ? 1 : 0.25 + 0.75 * proximity,
    color: pairColor(userId, peerId),
    frontTag: theirView?.tag,
    peerId,
    peerName: peer?.name,
    peerAvatarShape: peerAvatar?.shape,
    peerAvatarColor: peerAvatar?.color,
    closeness: talking ? 1 : proximity,
    conversationId: talking ? openConversation?.id : undefined,
  };
}
