import { mutation } from "./_generated/server";
import { loadRubric } from "./lib/rubric";
import { canonicalPair, otherOf } from "./lib/pairs";
import { queueText } from "./lib/texts";
import { log } from "./lib/activity";
import { GLOW_RANGE_M } from "./lib/constants";

/**
 * End of event: text everyone a recap of each conversation and an intro to
 * strong matches they were near but never talked to ("you passed by").
 * Trigger from the dashboard or: npx convex run event:end
 */
export const end = mutation({
  args: {},
  handler: async (ctx) => {
    const rubric = await loadRubric(ctx);
    const users = await ctx.db.query("users").collect();

    for (const me of users) {
      // Recaps
      const convos = [
        ...(await ctx.db.query("conversations").withIndex("by_a", (q) => q.eq("a", me._id)).collect()),
        ...(await ctx.db.query("conversations").withIndex("by_b", (q) => q.eq("b", me._id)).collect()),
      ];
      for (const c of convos) {
        if (!c.summary) continue;
        const o = await ctx.db.get(otherOf(c, me._id));
        const followUp = c.a === me._id ? c.followUpForA : c.followUpForB;
        await queueText(
          ctx,
          me.phone,
          `Recap with ${o?.name ?? "them"}: ${c.summary}${followUp ? ` Suggested follow up: ${followUp}` : ""}`,
        );
      }

      // Passed by: close at some point, strong match, never talked, not introduced yet
      const near = [
        ...(await ctx.db.query("proximity").withIndex("by_a", (q) => q.eq("a", me._id)).collect()),
        ...(await ctx.db.query("proximity").withIndex("by_b", (q) => q.eq("b", me._id)).collect()),
      ].filter((p) => p.minMeters <= GLOW_RANGE_M * 2);
      for (const p of near) {
        const otherId = otherOf(p, me._id);
        const pair = canonicalPair(me._id, otherId);
        const [talked, match, introduced] = await Promise.all([
          ctx.db.query("conversations").withIndex("by_pair", (q) => q.eq("a", pair.a).eq("b", pair.b)).first(),
          ctx.db.query("matches").withIndex("by_pair", (q) => q.eq("viewer", me._id).eq("other", otherId)).unique(),
          ctx.db.query("notifications").withIndex("by_owner_other", (q) => q.eq("owner", me._id).eq("other", otherId)).filter((q) => q.eq(q.field("kind"), "intro")).first(),
        ]);
        if (talked || introduced || !match || match.score < rubric.threshold) continue;
        const o = await ctx.db.get(otherId);
        await queueText(
          ctx,
          me.phone,
          `You were near ${o?.name ?? "someone"}${o?.headline ? ` (${o.headline})` : ""} today but didn't get to talk. ${match.reason ?? ""} Want me to introduce you?`,
        );
        await ctx.db.insert("notifications", { owner: me._id, other: otherId, kind: "intro", at: Date.now() });
        await log(ctx, me._id, otherId, "intro", `Agent suggested an intro to ${o?.name}`);
      }
    }
  },
});
