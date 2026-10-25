import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Heads up texts about strong matches who are at the event
crons.interval("heads up texts", { minutes: 1 }, internal.notify.headsUps, {});

// End conversations whose phones went quiet (app closed, battery died)
crons.interval("close stale conversations", { minutes: 1 }, internal.conversations.closeStale, {});

// Cloud text agent: answer new iMessages and send queued texts (no-op until
// PHOTON_API_KEY and PHOTON_PROJECT_ID are set in the Convex env)
crons.interval("text agent", { seconds: 5 }, internal.cloudAgent.tick, {});

export default crons;
