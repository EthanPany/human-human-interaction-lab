import { internalMutation } from "./_generated/server";

/** One off (Oct 25): the region default changed from California to Other. */
export const regionDefaultOther = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    for (const u of users) if (u.californiaMode !== false) await ctx.db.patch(u._id, { californiaMode: false });
    return users.length;
  },
});
