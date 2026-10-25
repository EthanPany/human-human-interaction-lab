import { query } from "./_generated/server";
import { v } from "convex/values";
import { loadRubric } from "./lib/rubric";
import { otherOf, pairColor } from "./lib/pairs";
import { avatarOf } from "./lib/avatar";
import { GLOW_RANGE_M, PROXIMITY_FRESH_MS, TALK_AFTER_MS, TALK_DISTANCE_M } from "./lib/constants";

/**
 * Everything the worn badge needs, as one live query. The phone subscribes and
 * re-renders whenever distances or matches change.
 *
 * mode:      idle | match | talking | connected
 * glow:      0..1, stronger as the matched person gets closer
 * color:     shared match color (same on both badges)
 * frontTag:  MY tag that the nearby person cares about most (moves to the front)
 * keywords:  1 to 3 short topics printed big under my name. With a match near:
 *            what I have that they want to discuss, or what we both want to.
 *            With nobody near: my own top tags.
 * closeness: 0..1 from distance alone (1 = talking distance), drives the avatar tint
 * peer*:     who it is, and their avatar, so the two avatars can meet on screen
 */
export const state = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await ctx.db.get(userId);
    const base = {
      mode: "idle" as "idle" | "match" | "talking" | "connected",
      glow: 0,
      color: undefined as string | undefined,
      frontTag: undefined as string | undefined,
      keywords: (me?.tags ?? []).slice(0, 3),
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

    const now = Date.now();
    const rubric = await loadRubric(ctx);
    const rows = [
      ...(await ctx.db.query("proximity").withIndex("by_a", (q) => q.eq("a", userId)).collect()),
      ...(await ctx.db.query("proximity").withIndex("by_b", (q) => q.eq("b", userId)).collect()),
    ].filter((r) => now - r.at < PROXIMITY_FRESH_MS && r.meters <= GLOW_RANGE_M);

    let best: { rank: number; row: (typeof rows)[number]; score: number } | undefined;
    for (const row of rows) {
      // The person I'm talking with always wins, so a stronger match walking
      // by can't interrupt (and end) the conversation.
      const latestTalk =
        row.closeSince !== undefined && now - row.closeSince >= TALK_AFTER_MS
          ? await ctx.db
              .query("conversations")
              .withIndex("by_pair", (q) => q.eq("a", row.a).eq("b", row.b))
              .order("desc")
              .first()
          : null;
      const inTalk = latestTalk !== null && latestTalk.endedAt === undefined;
      const peer = otherOf(row, userId);
      const [mine, theirs] = await Promise.all([
        ctx.db.query("matches").withIndex("by_pair", (q) => q.eq("viewer", userId).eq("other", peer)).unique(),
        ctx.db.query("matches").withIndex("by_pair", (q) => q.eq("viewer", peer).eq("other", userId)).unique(),
      ]);
      const score = Math.max(mine?.score ?? 0, theirs?.score ?? 0);
      if (score < rubric.threshold) continue;
      const proximity = Math.max(0, Math.min(1, (GLOW_RANGE_M - row.meters) / (GLOW_RANGE_M - TALK_DISTANCE_M)));
      const rank = inTalk ? 10 + score : score * (0.3 + 0.7 * proximity);
      if (!best || rank > best.rank) best = { rank, row, score };
    }
    if (!best) return base;

    const peerId = otherOf(best.row, userId);
    const [peer, theirView, connection, openConversation] = await Promise.all([
      ctx.db.get(peerId),
      ctx.db.query("matches").withIndex("by_pair", (q) => q.eq("viewer", peerId).eq("other", userId)).unique(),
      ctx.db.query("connections").withIndex("by_pair", (q) => q.eq("owner", userId).eq("other", peerId)).unique(),
      ctx.db
        .query("conversations")
        .withIndex("by_pair", (q) => q.eq("a", best!.row.a).eq("b", best!.row.b))
        .order("desc")
        .first(),
    ]);

    const talking =
      best.row.closeSince !== undefined &&
      now - best.row.closeSince >= TALK_AFTER_MS &&
      openConversation !== null &&
      openConversation.endedAt === undefined;

    const proximity = Math.max(0, Math.min(1, (GLOW_RANGE_M - best.row.meters) / (GLOW_RANGE_M - TALK_DISTANCE_M)));
    const peerAvatar = peer ? avatarOf(peer) : undefined;
    return {
      ...base,
      mode: talking ? "talking" : connection ? "connected" : "match",
      glow: talking ? 1 : 0.25 + 0.75 * proximity,
      color: pairColor(userId, peerId),
      frontTag: theirView?.tag,
      keywords: theirView?.keywords?.length
        ? theirView.keywords
        : theirView?.tag
          ? [theirView.tag]
          : base.keywords,
      peerId,
      peerName: peer?.name,
      peerAvatarShape: peerAvatar?.shape,
      peerAvatarColor: peerAvatar?.color,
      closeness: talking ? 1 : proximity,
      conversationId: talking ? openConversation?._id : undefined,
    };
  },
});
