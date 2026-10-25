import { QueryCtx } from "../_generated/server";
import { DEFAULT_RUBRIC } from "./constants";

/** The active matching rubric (stored row or defaults). */
export async function loadRubric(ctx: QueryCtx) {
  const row = await ctx.db
    .query("rubric")
    .withIndex("by_name", (q) => q.eq("name", "global"))
    .unique();
  return row ?? { name: "global", ...DEFAULT_RUBRIC };
}
