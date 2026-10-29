import { table, t } from "spacetimedb/server";

/**
 * Tables for group encounters (api/groups.ts): three or more badge wearers
 * standing together share one encounter. Kept apart from schema.ts so the
 * shared schema file only spreads them in. All new tables, no new columns on
 * existing ones (additive migration).
 *
 * A conversations row is still one encounter. Its `a` and `b` are the two
 * people it started with; everyone who was ever part of it has a row here.
 */

/** Who is (or was) in an encounter (`${conversationId}|${userId}`). Pairs have two rows. */
const encounterMembers = table(
  { name: "encounter_members" },
  {
    id: t.string().primaryKey(),
    conversationId: t.string().index("btree"),
    userId: t.string().index("btree"),
    /** First time they joined this encounter. */
    joinedAt: t.f64(),
    /** With the group right now since then (missing: not with them right now). */
    presentSince: t.f64().optional(),
    /** Last time they stood within reach of another member (the short leave grace counts from here). */
    lastTogetherAt: t.f64(),
    /** Last time they left (missing while present). */
    leftAt: t.f64().optional(),
    /** Time with the group in stretches that already ended (their own "Drop short encounters" counts this). */
    activeMs: t.f64(),
    /** Everyone they were with at some point in this encounter (their follow up names these people). */
    companions: t.array(t.string()),
    /** Their own follow up idea from the group summary. */
    followUp: t.string().optional(),
  },
);

/**
 * The one phone that records a group (three or more together), so the room is
 * not recorded by several phones at once. Pairs keep recording on both phones
 * (the longer transcript wins), as before.
 */
const encounterRecorders = table(
  { name: "encounter_recorders" },
  {
    conversationId: t.string().primaryKey(),
    userId: t.string(),
    since: t.f64(),
  },
);

/**
 * Transcript pieces as phones upload them (`${conversationId}|${userId}|${startedAt}`).
 * Pieces that cover the same time are duplicates (the longer one counts);
 * pieces one after another (the recorder changed) are joined in time order.
 */
const transcriptParts = table(
  { name: "transcript_parts" },
  {
    id: t.string().primaryKey(),
    conversationId: t.string().index("btree"),
    userId: t.string(),
    startedAt: t.f64(),
    endedAt: t.f64(),
    text: t.string(),
    at: t.f64(),
  },
);

/** Extra summary fields for group encounters: a few highlights from the transcript. */
const groupSummaries = table(
  { name: "group_summaries" },
  {
    conversationId: t.string().primaryKey(),
    highlights: t.array(t.string()),
    at: t.f64(),
  },
);

export const groupTables = { encounterMembers, encounterRecorders, transcriptParts, groupSummaries };
