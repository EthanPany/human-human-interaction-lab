import { cronJobs } from "convex/server";

// Convex is OFF. SpacetimeDB (spacetime/, database `hhil` on Maincloud) is the
// live backend and runs every recurring job there: heads up texts, closing
// stale conversations and the iMessage text agent tick. All crons are removed
// here so this deployment never answers or sends texts (that would double
// every reply). Its data is kept. See spacetime/README.md.
//
// Before the switch this file ran: "heads up texts" (1 min, notify.headsUps),
// "close stale conversations" (1 min, conversations.closeStale) and
// "text agent" (5 s, cloudAgent.tick).

const crons = cronJobs();

export default crons;
