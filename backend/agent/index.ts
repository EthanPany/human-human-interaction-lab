// Text message agent worker. Run: npm run agent   (or AGENT_TRANSPORT=console npm run agent)
import { ConvexClient } from "convex/browser";
import { config } from "./config";
import { Brain } from "./brain";
import { deliverOutbox } from "./outbox";
import { ConsoleTransport } from "./transports/console";
import { PhotonTransport } from "./transports/photon";
import type { Transport } from "./transports/transport";

function makeTransport(): Transport {
  if (config.transport === "console") return new ConsoleTransport();
  if (!config.photonProjectId || !config.photonProjectSecret) {
    throw new Error("Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET, or run with AGENT_TRANSPORT=console");
  }
  return new PhotonTransport(config.photonProjectId, config.photonProjectSecret);
}

async function main() {
  const convex = new ConvexClient(config.convexUrl);
  const transport = makeTransport();
  const brain = new Brain(convex);

  await transport.start(async ({ from, text }) => {
    console.log(`[${from}] ${text}`);
    try {
      const reply = await brain.reply(from, text);
      await transport.send(from, reply);
    } catch (e) {
      console.error("reply failed", e);
      await transport.send(from, "Sorry, I hit a snag. Try again in a moment?");
    }
  });

  deliverOutbox(convex, transport);
  console.log(`Agent running (${transport.name}) against ${config.convexUrl}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
