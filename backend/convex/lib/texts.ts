import { MutationCtx } from "../_generated/server";
import { isDemoPhone } from "./phone";

/**
 * Queue a text for the agent to send. Demo profiles are skipped, and so is
 * anyone who texted STOP. kind "welcome" marks the sign up hello: it waits
 * until they first text the line (a shared iMessage line can't text first)
 * and is dropped once the agent has answered them directly.
 */
export async function queueText(ctx: MutationCtx, phone: string, body: string, kind?: "welcome") {
  if (isDemoPhone(phone)) return;
  const user = await ctx.db
    .query("users")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .unique();
  if (user?.textsPaused) return;
  await ctx.db.insert("outbox", { phone, body, at: Date.now(), kind });
}
