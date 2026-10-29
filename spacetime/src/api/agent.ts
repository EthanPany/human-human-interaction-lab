import { DEFAULT_RUBRIC } from "../lib/constants";
import { normalizePhone } from "../lib/phone";
import { connectionOf, conversationsOf, directedKey, log, newId, nowMs, otherOf, scheduleRescoreAll } from "../lib/db";
import { anonymousHint } from "../lib/privacy";
import type { Tx } from "../schema";
import { haveMet } from "./notify";
import { applyPatch, blankUser, parsePatch, userByPhone } from "./users";

/**
 * Port of backend/convex/agent.ts: what the text agent can read and change,
 * keyed by the phone number a message came from. Each function runs inside
 * one transaction (the cloud agent procedure opens one per call).
 */

/** What the agent should know before replying. */
export function context(tx: Tx, phone: string) {
  const user = userByPhone(tx, phone);
  if (!user) return { user: null, pendingContact: null, topMatches: [] };

  // Most recent finished conversation that I have not saved yet.
  const convos = conversationsOf(tx, user.id).sort((x, y) => y.startedAt - x.startedAt);
  let pendingContact = null;
  for (const c of convos) {
    if (c.endedAt === undefined) continue;
    const other = otherOf(c, user.id);
    if (!connectionOf(tx, user.id, other)) {
      const o = tx.db.users.id.find(other);
      pendingContact = { userId: other, name: o?.name ?? "them" };
    }
    break;
  }

  // People they have not met yet are described only by their badge, stated look and one
  // broad topic (lib/privacy.ts). The agent never even sees their name or company.
  const matches = [...tx.db.matches.viewer.filter(user.id)].sort((x, y) => y.score - x.score).slice(0, 3);
  const topMatches = matches.map((m) => {
    const o = tx.db.users.id.find(m.other);
    if (!o) return { met: false, score: m.score };
    if (haveMet(tx, user.id, o.id)) return { met: true, name: o.name, headline: o.headline, score: m.score, reason: m.reason };
    return { met: false, ...anonymousHint(o), score: m.score };
  });

  const { password, photoId, ...profile } = user;
  return { user: profile, pendingContact, topMatches };
}

/** Someone texted first: make sure they have an account. */
export function ensureUser(tx: Tx, phone: string) {
  const existing = userByPhone(tx, phone);
  if (existing) return existing.id;
  const id = newId(tx);
  tx.db.users.insert(blankUser(id, normalizePhone(phone)));
  return id;
}

/** Save profile fields the agent learned over text. */
export function saveProfile(tx: Tx, phone: string, patch: Record<string, unknown>) {
  const user = userByPhone(tx, phone);
  if (!user) throw new Error("No user for this phone");
  applyPatch(tx, user.id, parsePatch(patch));
}

/** "Y" after a conversation: save the most recent unsaved person. */
export function confirmContact(tx: Tx, phone: string): string | null {
  const user = userByPhone(tx, phone);
  if (!user) return null;
  const convos = conversationsOf(tx, user.id).sort((x, y) => y.startedAt - x.startedAt);
  for (const c of convos) {
    const other = otherOf(c, user.id);
    if (connectionOf(tx, user.id, other)) continue;
    tx.db.connections.insert({ id: directedKey(user.id, other), owner: user.id, other, at: nowMs(tx) });
    const o = tx.db.users.id.find(other);
    log(tx, user.id, other, "saved", `Saved ${o?.name ?? "contact"} (confirmed by text)`);
    return o?.name ?? "them";
  }
  return null;
}

export function addFeedback(tx: Tx, phone: string, note: string, rating?: number, otherName?: string) {
  const user = userByPhone(tx, phone);
  if (!user) return;
  let other: string | undefined;
  if (otherName) {
    other = [...tx.db.users.iter()].find((u) => u.name?.toLowerCase() === otherName.toLowerCase())?.id;
  }
  tx.db.feedback.insert({ id: newId(tx), owner: user.id, other, rating, note, at: nowMs(tx) });
}

export function updateRubricNotes(tx: Tx, notes: string) {
  const row = tx.db.rubric.name.find("global");
  if (row) tx.db.rubric.name.update({ ...row, notes });
  else tx.db.rubric.insert({ name: "global", ...DEFAULT_RUBRIC, notes });
  scheduleRescoreAll(tx);
}
