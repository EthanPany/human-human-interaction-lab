import type { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Transport } from "./transports/transport";

/** Deliver every queued text exactly once. Convex pushes updates live. */
export function deliverOutbox(convex: ConvexClient, transport: Transport) {
  const inFlight = new Set<string>();
  convex.onUpdate(api.outbox.pending, {}, async (messages) => {
    for (const m of messages) {
      if (inFlight.has(m._id)) continue;
      inFlight.add(m._id);
      try {
        await transport.send(m.phone, m.body);
        await convex.mutation(api.outbox.markSent, { id: m._id });
      } catch (e) {
        console.error(`send to ${m.phone} failed`, e);
        inFlight.delete(m._id); // retry on the next update
      }
    }
  });
}
