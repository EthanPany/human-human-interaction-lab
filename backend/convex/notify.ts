import { internalMutation } from "./_generated/server";
import { loadRubric } from "./lib/rubric";
import { queueText } from "./lib/texts";
import { log } from "./lib/activity";
import { ACTIVE_WINDOW_MS, HEADSUP_COOLDOWN_MS } from "./lib/constants";

/**
 * Runs every minute (crons.ts). For each person at the event, text them about
 * their best match they have not met or heard about yet, at most once per
 * cooldown. The badge glow takes over once they are within UWB range.
 */
export const headsUps = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rubric = await loadRubric(ctx);
    const users = (await ctx.db.query("users").collect()).filter(
      (u) => (u.lastSeenAt ?? 0) > now - ACTIVE_WINDOW_MS,
    );
    const activeIds = new Set(users.map((u) => u._id));

    for (const me of users) {
      const last = await ctx.db
        .query("notifications")
        .withIndex("by_owner", (q) => q.eq("owner", me._id))
        .order("desc")
        .first();
      if (last && now - last.at < HEADSUP_COOLDOWN_MS) continue;

      const candidates = await ctx.db
        .query("matches")
        .withIndex("by_viewer", (q) => q.eq("viewer", me._id))
        .order("desc")
        .take(10);

      for (const m of candidates) {
        if (m.score < rubric.threshold) break;
        if (!activeIds.has(m.other)) continue;
        const [told, saved] = await Promise.all([
          ctx.db.query("notifications").withIndex("by_owner_other", (q) => q.eq("owner", me._id).eq("other", m.other)).first(),
          ctx.db.query("connections").withIndex("by_pair", (q) => q.eq("owner", me._id).eq("other", m.other)).unique(),
        ]);
        if (told || saved) continue;

        const o = await ctx.db.get(m.other);
        if (!o) continue;
        const parts = [
          `Heads up: ${o.name}${o.headline ? `, ${o.headline},` : ""} is here.`,
          m.reason,
          o.appearance ? `Look for: ${o.appearance}.` : undefined,
          "Your badges will glow when you're close.",
        ].filter(Boolean);
        await queueText(ctx, me.phone, parts.join(" "));
        await ctx.db.insert("notifications", { owner: me._id, other: m.other, kind: "headsup", at: now });
        await log(ctx, me._id, m.other, "headsup", `Agent texted a heads up about ${o.name}`);
        break;
      }
    }
  },
});
