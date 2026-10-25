import { MutationCtx } from "../_generated/server";
import { isDemoPhone } from "./phone";

/** Queue a text for the agent worker to send. Demo profiles are skipped. */
export async function queueText(ctx: MutationCtx, phone: string, body: string) {
  if (isDemoPhone(phone)) return;
  await ctx.db.insert("outbox", { phone, body, at: Date.now() });
}
