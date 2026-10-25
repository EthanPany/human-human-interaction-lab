import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Heads up texts about strong matches who are at the event
crons.interval("heads up texts", { minutes: 1 }, internal.notify.headsUps, {});

export default crons;
