import { ConvexHttpClient } from "convex/browser";
import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

/**
 * The bits of ConvexClient the agent uses, over plain HTTPS. Some networks
 * (VPNs, proxies) drop Convex's WebSocket; live updates become a 2 s poll.
 */
export function httpConvex(url: string): ConvexClient {
  const http = new ConvexHttpClient(url);
  const client = {
    query: (fn: FunctionReference<"query">, args: any) => http.query(fn, args),
    mutation: (fn: FunctionReference<"mutation">, args: any) => http.mutation(fn, args),
    action: (fn: FunctionReference<"action">, args: any) => http.action(fn, args),
    onUpdate: (fn: FunctionReference<"query">, args: any, callback: (value: any) => void) => {
      let last = "";
      const tick = async () => {
        try {
          const value = await http.query(fn, args);
          const key = JSON.stringify(value);
          if (key !== last) {
            last = key;
            callback(value);
          }
        } catch (e) {
          console.error("poll failed", e instanceof Error ? e.message : e);
        }
      };
      void tick();
      const timer = setInterval(tick, 2000);
      return () => clearInterval(timer);
    },
    close: async () => undefined,
  };
  return client as unknown as ConvexClient;
}
