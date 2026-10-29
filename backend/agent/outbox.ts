import type { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Transport } from "./transports/transport";
import type { Id } from "../convex/_generated/dataModel";

/** Deliver every queued text exactly once. Convex pushes updates live. */
export function deliverOutbox(convex: ConvexClient, transport: Transport) {
  const inFlight = new Set<string>();
  type Pending = { _id: Id<"outbox">; phone: string; body: string };
  let latest: Pending[] = [];

  const deliver = async (messages: Pending[]) => {
    for (const m of messages) {
      if (inFlight.has(m._id)) continue;
      inFlight.add(m._id);
      try {
        await transport.send(m.phone, m.body);
        await convex.mutation(api.outbox.markSent, { id: m._id });
      } catch (e) {
        console.error(`send to ${m.phone} failed`, e);
        inFlight.delete(m._id); // retried by the timer below
      }
    }
  };

  convex.onUpdate(api.outbox.pending, {}, (messages) => {
    latest = messages;
    void deliver(latest);
  });
  // Failed sends get another try every 30 seconds even if nothing new is queued.
  setInterval(() => void deliver(latest), 30_000);
}
