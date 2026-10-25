import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

/** Append a timeline entry for `owner` (optionally about `other`). */
export async function log(
  ctx: MutationCtx,
  owner: Id<"users">,
  other: Id<"users"> | undefined,
  kind: string,
  text: string,
) {
  await ctx.db.insert("activity", { owner, other, kind, text, at: Date.now() });
}
