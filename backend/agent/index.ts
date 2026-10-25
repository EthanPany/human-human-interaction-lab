// Text message agent worker. Run: npm run agent   (or AGENT_TRANSPORT=console npm run agent)
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { config } from "./config";
import { Brain } from "./brain";
import { deliverOutbox } from "./outbox";
import { ConsoleTransport } from "./transports/console";
import { PhotonTransport } from "./transports/photon";
import { Photon2Transport } from "./transports/photon2";
import type { Transport } from "./transports/transport";

function makeTransport(): Transport {
  if (config.transport === "console") return new ConsoleTransport();
  if (config.transport === "photon2") {
    if (!config.photonProjectId || !config.photonApiKey) {
      throw new Error("Set PHOTON_PROJECT_ID and PHOTON_API_KEY in .env.local, or run npm run agent:console");
    }
    return new Photon2Transport(config.photonProjectId, config.photonApiKey);
  }
  if (!config.photonProjectId || !config.photonProjectSecret) {
    throw new Error("Set PHOTON_PROJECT_ID and PHOTON_API_KEY (Photon 2.0) in .env.local, or run npm run agent:console");
  }
  return new PhotonTransport(config.photonProjectId, config.photonProjectSecret);
}

async function main() {
  const convex = new ConvexClient(config.convexUrl);
  const cloudEnabled = (await convex.query(api.cloudAgent.status, {})).enabled;
  if (config.transport !== "console" && cloudEnabled) {
    console.log("The text agent is already running in Convex (PHOTON_* set in the Convex env). Nothing to start here.");
    console.log("Use `npm run agent:console` to chat with it in the terminal instead.");
    process.exit(0);
  }
  const transport = makeTransport();
  const brain = new Brain(convex);

  await transport.start(async ({ from, text }) => {
    console.log(`[${from}] ${text}`);
    try {
      const reply = await brain.reply(from, text);
      await transport.send(from, reply);
    } catch (e) {
      console.error("reply failed", e);
      await transport.send(from, "Sorry, I hit a snag. Try again in a moment?").catch(() => undefined);
    }
  });

  // The cloud agent owns the outbox when it's on; don't steal its texts.
  if (!cloudEnabled) deliverOutbox(convex, transport);
  console.log(`Agent running (${transport.name}) against ${config.convexUrl}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
