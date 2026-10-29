import type { ProcedureCtx } from "spacetimedb/server";
import type { S, Tx } from "../schema";
import { nowMs, pendingWelcome, scheduleLineCheck } from "../lib/db";
import { isDemoPhone, normalizePhone } from "../lib/phone";
import { noteUnsolicited } from "./cloudAgent";
import { assignLine, lineFor, needsInboundFirst, normalizeHandle, openDirect, photonConfigured, sendText } from "../lib/photonApi";

/**
 * Port of backend/convex/photonAssign.ts. Every account is added to the Photon
 * iMessage pool automatically, so the number someone signs up with is the
 * number that can text the agent (blue bubbles), with no manual step in the
 * dashboard. The assigned line is saved in `agent_lines`; the app's
 * "Text your agent" opens that line (users:me returns it as agentLine).
 */

function saveLine(tx: Tx, phone: string, line: string) {
  const row = { phone, line, updatedAt: nowMs(tx) };
  if (tx.db.agentLines.phone.find(phone)) tx.db.agentLines.phone.update(row);
  else tx.db.agentLines.insert(row);
}

/** photonAssign:ensure. Runs from the photon_assign_job schedule (every sign in, backfill). */
export function ensure(ctx: ProcedureCtx<S>, userId: string) {
  const env = ctx.env;
  if (!photonConfigured(env)) return;
  const u = ctx.withTx((tx) => {
    const row = tx.db.users.id.find(userId);
    return row ? { phone: row.phone, agentLine: tx.db.agentLines.phone.find(row.phone)?.line } : null;
  });
  if (!u || isDemoPhone(u.phone) || u.phone.includes("@")) return;
  let line: string | undefined;
  try {
    // Photon's assignment is the truth; the saved line may be stale
    line = lineFor(ctx.http, env, u.phone) ?? assignLine(ctx.http, env, u.phone);
  } catch (e) {
    console.error("Photon assignment failed", u.phone, e);
    return;
  }
  if (!line) return;
  if (line === u.agentLine) return; // already set up, welcome handled before
  const assigned = line;
  ctx.withTx((tx) => saveLine(tx, u.phone, assigned));
  console.log(`Photon line for ${u.phone}: ${assigned}`);

  // Try to say hi right away. A dedicated line can text first; the shared
  // pool refuses until they text in, and then the cloud agent greets them.
  const welcome = ctx.withTx((tx) => pendingWelcome(tx, u.phone));
  if (!welcome) return;
  try {
    const { spaceId, agentUserId } = openDirect(ctx.http, env, assigned, u.phone);
    sendText(ctx.http, env, spaceId, agentUserId, welcome.body, `outbox:${welcome.id}`);
    ctx.withTx((tx) => {
      const key = normalizeHandle(u.phone);
      const row = { phone: key, spaceId, agentUserId, updatedAt: nowMs(tx) };
      if (tx.db.photonConversations.phone.find(key)) tx.db.photonConversations.phone.update(row);
      else tx.db.photonConversations.insert(row);
      const w = tx.db.outbox.id.find(welcome.id);
      if (w) tx.db.outbox.id.update({ ...w, sent: true, sentAt: nowMs(tx) });
      noteUnsolicited(tx, u.phone);
    });
  } catch (e) {
    if (needsInboundFirst(e)) console.log(`welcome for ${u.phone} waits for their first text (shared line)`);
    else console.error("welcome send failed", u.phone, e);
  }
}

/** photonAssign:backfill. One off: check everyone who signed up before this existed. */
export function backfill(tx: Tx) {
  let n = 0;
  for (const u of tx.db.users.iter()) {
    if (isDemoPhone(u.phone)) continue; // ensure skips anyone already right
    scheduleLineCheck(tx, u.id, n * 500);
    n++;
  }
  console.log(`photon backfill: checking ${n} people`);
  return n;
}

/** photonAssign:setLine. A dedicated line for one person. */
export function setLine(tx: Tx, phone: string, line: string) {
  const u = tx.db.users.phone.find(normalizePhone(phone));
  if (!u) return "no user with that phone";
  saveLine(tx, u.phone, normalizePhone(line));
  return `${u.name ?? u.phone}: ${normalizePhone(line)}`;
}
