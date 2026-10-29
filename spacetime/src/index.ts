import { ScheduleAt } from "spacetimedb";
import { t } from "spacetimedb/server";
import spacetimedb, { agentJob, minuteJob, photonAssignJob, rescoreAllJob, rescoreJob, summarizeJob, type Tx } from "./schema";
import { closeStale } from "./api/conversations";
import { endEvent, headsUps } from "./api/notify";
import { profileChanged, rescoreAll as rescoreEveryone } from "./api/matching";
import { summarizeConversation } from "./api/summarize";
import { sendCard, tick } from "./api/cloudAgent";
import { backfill, ensure, setLine } from "./api/photonAssign";
import { seedDemo, seedTestPair } from "./api/seed";
import { scheduleRescoreAll } from "./lib/db";

/**
 * HHIL backend on SpacetimeDB. The app-facing API is HTTP (src/http.ts);
 * this file wires the schedule tables (Convex crons and scheduler) and the
 * admin reducers you run with `spacetime call`.
 */

export default spacetimedb;
export { router, rpc, upload, photo, health } from "./http";

/** Start the recurring jobs once (Convex crons.ts). Safe to call again. */
function ensureJobsIn(tx: Tx) {
  if (tx.db.minuteJob.count() === 0n) {
    tx.db.minuteJob.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(60_000_000n) });
  }
  if (tx.db.agentJob.count() === 0n) {
    tx.db.agentJob.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(5_000_000n) });
  }
}

export const init = spacetimedb.init((ctx) => ensureJobsIn(ctx));

/** After a publish that kept data: `spacetime call <db> ensure_jobs`. */
export const ensureJobs = spacetimedb.reducer((ctx) => ensureJobsIn(ctx));

// Recurring ------------------------------------------------------------------

/** Every minute: heads up texts, then end conversations whose phones went quiet. */
export const everyMinute = spacetimedb.reducer({ onSchedule: minuteJob }, { arg: minuteJob.rowType }, (ctx) => {
  headsUps(ctx);
  closeStale(ctx);
});

/** Every 5 seconds: the Photon text agent (no-op until its env is set). */
export const agentTick = spacetimedb.procedure({ onSchedule: agentJob }, { arg: agentJob.rowType }, t.unit(), (ctx) => {
  tick(ctx);
  return {};
});

// One shot ---------------------------------------------------------------------

export const summarize = spacetimedb.procedure({ onSchedule: summarizeJob }, { arg: summarizeJob.rowType }, t.unit(), (ctx, { arg }) => {
  summarizeConversation(ctx, arg.conversationId);
  return {};
});

export const rescoreProfile = spacetimedb.procedure({ onSchedule: rescoreJob }, { arg: rescoreJob.rowType }, t.unit(), (ctx, { arg }) => {
  profileChanged(ctx, arg.userId, arg.requestedAt);
  return {};
});

export const rescoreAll = spacetimedb.procedure({ onSchedule: rescoreAllJob }, { arg: rescoreAllJob.rowType }, t.unit(), (ctx) => {
  rescoreEveryone(ctx);
  return {};
});

/** Check one person's Photon line (photonAssign:ensure), scheduled by sign in and the backfill. */
export const photonEnsure = spacetimedb.procedure({ onSchedule: photonAssignJob }, { arg: photonAssignJob.rowType }, t.unit(), (ctx, { arg }) => {
  ensure(ctx, arg.userId);
  return {};
});

// Admin (demo only, like the public Convex mutations) -------------------------

/** spacetime call <db> seed_demo */
export const seed = spacetimedb.reducer({ name: "seed_demo" }, (ctx) => seedDemo(ctx));

/** spacetime call <db> seed_test_pair  (Theo and Nora, the two phone test attendees) */
export const seedPair = spacetimedb.reducer({ name: "seed_test_pair" }, (ctx) => seedTestPair(ctx));

/** spacetime call <db> rescore */
export const rescore = spacetimedb.reducer((ctx) => scheduleRescoreAll(ctx));

/** spacetime call <db> end_event */
export const endEventReducer = spacetimedb.reducer({ name: "end_event" }, (ctx) => endEvent(ctx));

/** spacetime call <db> photon_backfill  (check everyone's Photon line, one every 0.5 s) */
export const photonBackfill = spacetimedb.reducer({ name: "photon_backfill" }, (ctx) => {
  backfill(ctx);
});

/** spacetime call <db> photon_set_line '"+15852106589"' '"+14156052974"'  (a dedicated line for one person) */
export const photonSetLine = spacetimedb.reducer({ name: "photon_set_line" }, { phone: t.string(), line: t.string() }, (ctx, { phone, line }) => {
  console.log(setLine(ctx, phone, line));
});

/** spacetime call <db> send_card '"+1..."'  (resend the agent's contact card into their thread) */
export const sendCardProcedure = spacetimedb.procedure({ name: "send_card" }, { phone: t.string() }, t.string(), (ctx, { phone }) => sendCard(ctx, phone));
