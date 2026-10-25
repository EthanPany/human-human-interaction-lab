import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { RESCORE_DEBOUNCE_MS } from "./constants";

/** Mark a profile as edited and re-score it once the burst of edits settles. */
export async function requestRescore(ctx: MutationCtx, userId: Id<"users">) {
  const requestedAt = Date.now();
  await ctx.db.patch(userId, { profileUpdatedAt: requestedAt });
  await ctx.scheduler.runAfter(RESCORE_DEBOUNCE_MS, internal.matching.profileChanged, { userId, requestedAt });
}
