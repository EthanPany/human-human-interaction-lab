import { ACTIVE_WINDOW_MS, GLOW_RANGE_M, HEADSUP_COOLDOWN_MS } from "../lib/constants";
import { connectionOf, conversationsOf, latestConversation, loadRubric, log, matchOf, newId, nowMs, otherOf, proximityOf, queueText } from "../lib/db";
import type { Tx } from "../schema";

/** Ports of backend/convex/notify.ts (heads ups, every minute) and event.ts (end of event). */

export function headsUps(tx: Tx) {
  const now = nowMs(tx);
  const rubric = loadRubric(tx);
  const users = [...tx.db.users.iter()].filter((u) => (u.lastSeenAt ?? 0) > now - ACTIVE_WINDOW_MS);
  const activeIds = new Set(users.map((u) => u.id));

  for (const me of users) {
    const mine = [...tx.db.notifications.owner.filter(me.id)];
    const last = mine.reduce((m, n) => Math.max(m, n.at), -Infinity);
    if (now - last < HEADSUP_COOLDOWN_MS) continue;

    const candidates = [...tx.db.matches.viewer.filter(me.id)].sort((x, y) => y.score - x.score).slice(0, 10);
    for (const m of candidates) {
      if (m.score < rubric.threshold) break;
      if (!activeIds.has(m.other)) continue;
      const told = mine.some((n) => n.other === m.other);
      if (told || connectionOf(tx, me.id, m.other)) continue;

      const o = tx.db.users.id.find(m.other);
      if (!o) continue;
      const parts = [
        `Heads up: ${o.name}${o.headline ? `, ${o.headline},` : ""} is here.`,
        m.reason,
        o.appearance ? `Look for: ${o.appearance}.` : undefined,
        "Your badges will glow when you're close.",
      ].filter(Boolean);
      queueText(tx, me.phone, parts.join(" "));
      tx.db.notifications.insert({ id: newId(tx), owner: me.id, other: m.other, kind: "headsup", at: now });
      log(tx, me.id, m.other, "headsup", `Agent texted a heads up about ${o.name}`);
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
    for (const c of conversationsOf(tx, me.id)) {
      if (!c.summary) continue;
      const o = tx.db.users.id.find(otherOf(c, me.id));
      const followUp = c.a === me.id ? c.followUpForA : c.followUpForB;
      queueText(tx, me.phone, `Recap with ${o?.name ?? "them"}: ${c.summary}${followUp ? ` Suggested follow up: ${followUp}` : ""}`);
    }

    const near = proximityOf(tx, me.id).filter((p) => p.minMeters <= GLOW_RANGE_M * 2);
    for (const p of near) {
      const otherId = otherOf(p, me.id);
      const talked = latestConversation(tx, me.id, otherId);
      const match = matchOf(tx, me.id, otherId);
      const introduced = [...tx.db.notifications.owner.filter(me.id)].some((n) => n.other === otherId && n.kind === "intro");
      if (talked || introduced || !match || match.score < rubric.threshold) continue;
      const o = tx.db.users.id.find(otherId);
      queueText(
        tx,
        me.phone,
        `You were near ${o?.name ?? "someone"}${o?.headline ? ` (${o.headline})` : ""} today but didn't get to talk. ${match.reason ?? ""} Want me to introduce you?`,
      );
      tx.db.notifications.insert({ id: newId(tx), owner: me.id, other: otherId, kind: "intro", at: nowMs(tx) });
      log(tx, me.id, otherId, "intro", `Agent suggested an intro to ${o?.name}`);
    }
  }
}
