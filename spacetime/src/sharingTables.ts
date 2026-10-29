import { table, t } from "spacetimedb/server";

/**
 * Tables for contact sharing and profile photos (api/sharing.ts, api/profilePhoto.ts).
 * Kept apart from schema.ts so the shared schema file only spreads them in.
 * All new tables, no new columns on existing ones (additive migration).
 */

/** Things a person can share with people they meet ("What I share" in Settings). */
const shareItems = table(
  { name: "share_items" },
  {
    id: t.string().primaryKey(),
    owner: t.string().index("btree"),
    /** linkedin | website | github | x | instagram | email | phone | link | image */
    kind: t.string(),
    /** Their own name for it ("Portfolio", "My QR code"). Missing: the kind's name. */
    label: t.string().optional(),
    /** URL, handle, email or phone. Missing for images. */
    value: t.string().optional(),
    /** Images (a QR code, a card): the photos row with the bytes. */
    photoId: t.string().optional(),
    /** Preselected when sharing. */
    includeByDefault: t.bool(),
    /** Order in the list (lower first). */
    position: t.f64(),
    updatedAt: t.f64(),
  },
);

/**
 * A share waiting for the other person. `offer`: the sender shares their items
 * with the recipient. `ask`: the sender asks for the recipient's items.
 * `handshake`: the first half of a mutual share (Apple Watch, Phase 6).
 */
const shareRequests = table(
  { name: "share_requests" },
  {
    id: t.string().primaryKey(),
    sender: t.string().index("btree"),
    recipient: t.string().index("btree"),
    kind: t.string(),
    /** offer and handshake: the sender's items. ask: empty (the recipient picks). */
    itemIds: t.array(t.string()),
    /** pending | approved | declined | cancelled | expired */
    status: t.string(),
    /** app | watch */
    source: t.string(),
    createdAt: t.f64(),
    respondedAt: t.f64().optional(),
  },
);

/** What one person currently shares with another (`${owner}|${viewer}`). Items are live: edits show up. */
const shareGrants = table(
  { name: "share_grants" },
  {
    id: t.string().primaryKey(),
    owner: t.string().index("btree"),
    viewer: t.string().index("btree"),
    itemIds: t.array(t.string()),
    at: t.f64(),
    updatedAt: t.f64(),
  },
);

/** The iMessage nudge queued for a share request (outbox id to request), so an answered request drops it. */
const shareNudges = table(
  { name: "share_nudges" },
  {
    outboxId: t.string().primaryKey(),
    requestId: t.string(),
    pair: t.string().index("btree"), // `${sender}|${recipient}`
    at: t.f64(),
  },
);

/** The square profile photo (People rows and pages). Separate from the badge photo (users.photoId). */
const profilePhotos = table(
  { name: "profile_photos" },
  {
    userId: t.string().primaryKey(),
    photoId: t.string(),
    at: t.f64(),
  },
);

export const sharingTables = { shareItems, shareRequests, shareGrants, shareNudges, profilePhotos };
