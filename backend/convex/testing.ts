import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { canonicalPair } from "./lib/pairs";

/** Only these fictional numbers can be reset (used by scripts/e2e.ts). */
const TEST_PHONES = ["+14155550190", "+14155550191"];

/** Forget everything between the two e2e test users so the test can rerun. */
export const resetTestPair = mutation({
  args: { phones: v.array(v.string()) },
  handler: async (ctx, { phones }) => {
    if (phones.length !== 2 || !phones.every((p) => TEST_PHONES.includes(p))) throw new Error("Test numbers only");
    const users = [];
    for (const phone of phones) {
      const u = await ctx.db.query("users").withIndex("by_phone", (q) => q.eq("phone", phone)).unique();
      if (u) users.push(u._id);
    }
    if (users.length !== 2) return;
    const [x, y] = users;
    const { a, b } = canonicalPair(x, y);
    for (const c of await ctx.db.query("conversations").withIndex("by_pair", (q) => q.eq("a", a).eq("b", b)).collect())
      await ctx.db.delete(c._id);
    for (const p of await ctx.db.query("proximity").withIndex("by_pair", (q) => q.eq("a", a).eq("b", b)).collect())
      await ctx.db.delete(p._id);
    for (const [owner, other] of [[x, y], [y, x]] as const) {
      for (const c of await ctx.db.query("connections").withIndex("by_pair", (q) => q.eq("owner", owner).eq("other", other)).collect())
        await ctx.db.delete(c._id);
      for (const t of await ctx.db.query("activity").withIndex("by_owner_other", (q) => q.eq("owner", owner).eq("other", other)).collect())
        await ctx.db.delete(t._id);
    }
  },
});
