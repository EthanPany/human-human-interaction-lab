import { ACTIVE_WINDOW_MS, GLOW_RANGE_M, HEADSUP_COOLDOWN_MS } from "../lib/constants";
import { connectionOf, conversationsOf, latestConversation, loadRubric, log, matchOf, newId, nowMs, otherOf, pairKey, proximityOf, queueText } from "../lib/db";
import { headsUpText } from "../lib/privacy";
import { hasSummary } from "./followUp";
import { freshLocation, roughlyTogether } from "./location";
import type { Tx } from "../schema";

/** Ports of backend/convex/notify.ts (heads ups, every minute) and event.ts (end of event). */

/** A heads up is only useful while they are still around. */
const HEADSUP_TTL_MS = 10 * 60_000;

/** Have these two met or talked already? Then names are fine; before that, the agent stays vague. */
export function haveMet(tx: Tx, me: string, other: string) {
  return Boolean(tx.db.meetings.id.find(pairKey(me, other)) || latestConversation(tx, me, other) || connectionOf(tx, me, other));
}

/**
 * Every minute: text people about a strong match who is here now. Privacy
 * first: only when both are at the event and their phones are within about
 * 300 m (coarse location, api/location.ts), and the text describes only the
 * badge, their stated look and one broad topic (lib/privacy.ts), never who
 * they are.
 */
export function headsUps(tx: Tx) {
  const now = nowMs(tx);
  const rubric = loadRubric(tx);
  const users = [...tx.db.users.iter()].filter((u) => (u.lastSeenAt ?? 0) > now - ACTIVE_WINDOW_MS);
  const activeIds = new Set(users.map((u) => u.id));

  for (const me of users) {
    if (!freshLocation(tx, me.id)) continue; // no recent coarse location: no heads ups
    const mine = [...tx.db.notifications.owner.filter(me.id)];
    const last = mine.reduce((m, n) => Math.max(m, n.at), -Infinity);
    if (now - last < HEADSUP_COOLDOWN_MS) continue;

    const candidates = [...tx.db.matches.viewer.filter(me.id)].sort((x, y) => y.score - x.score).slice(0, 10);
    for (const m of candidates) {
      if (m.score < rubric.threshold) break;
      if (!activeIds.has(m.other)) continue; // same event: both checked in recently
      const told = mine.some((n) => n.other === m.other);
      if (told || haveMet(tx, me.id, m.other)) continue;
      if (!roughlyTogether(tx, me.id, m.other)) continue;

      const o = tx.db.users.id.find(m.other);
      if (!o) continue;
      queueText(tx, me.phone, headsUpText(o), undefined, { kind: "headsup", expiresAt: now + HEADSUP_TTL_MS });
      tx.db.notifications.insert({ id: newId(tx), owner: me.id, other: m.other, kind: "headsup", at: now });
      log(tx, me.id, m.other, "headsup", `Agent texted a heads up about ${o.name ?? "a match"} (badge only)`);
      break;
    }
  }
}

/**
 * End of event: text everyone a recap of each conversation and an intro to
 * strong matches they were near but never talked to ("you passed by").
 */
export function endEvent(tx: Tx) {
  const rubric = loadRubric(tx);
  for (const me of [...tx.db.users.iter()]) {
    // One text per person, not one per conversation: the agent never piles texts on someone.
    const lines: string[] = [];
    for (const c of conversationsOf(tx, me.id)) {
      if (!hasSummary(c.summary)) continue;
      const o = tx.db.users.id.find(otherOf(c, me.id));
      const followUp = c.a === me.id ? c.followUpForA : c.followUpForB;
      lines.push(`${o?.name ?? "Someone"}: ${c.summary}${followUp ? ` Follow up idea: ${followUp}` : ""}`);
    }

    const intros: string[] = [];
    const near = proximityOf(tx, me.id).filter((p) => p.minMeters <= GLOW_RANGE_M * 2);
    for (const p of near) {
      const otherId = otherOf(p, me.id);
      const talked = latestConversation(tx, me.id, otherId);
      const match = matchOf(tx, me.id, otherId);
      const introduced = [...tx.db.notifications.owner.filter(me.id)].some((n) => n.other === otherId && n.kind === "intro");
      if (talked || introduced || !match || match.score < rubric.threshold) continue;
      const o = tx.db.users.id.find(otherId);
      intros.push(`${o?.name ?? "someone"}${o?.headline ? ` (${o.headline})` : ""}`);
      tx.db.notifications.insert({ id: newId(tx), owner: me.id, other: otherId, kind: "intro", at: nowMs(tx) });
      log(tx, me.id, otherId, "intro", `Agent suggested an intro to ${o?.name}`);
      if (intros.length >= 2) break;
    }

    const parts = [
      lines.length ? `Your recap from today. ${lines.slice(0, 4).join(" ")}` : undefined,
      intros.length ? `You were near ${intros.join(" and ")} but didn't get to talk. Want me to introduce you?` : undefined,
    ].filter(Boolean);
    if (parts.length) queueText(tx, me.phone, parts.join("\n\n"), undefined, { kind: "recap" });
  }
}
