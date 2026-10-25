import * as readline from "node:readline";
import type { IncomingText, Transport } from "./transport";

/**
 * Chat with the agent in the terminal, no Photon needed.
 *   /as +15551234567   pretend to be this phone number
 *   anything else      is sent as a text from that number
 */
export class ConsoleTransport implements Transport {
  readonly name = "console";
  private from = "+15550000000";

  async start(onText: (msg: IncomingText) => Promise<void>) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Console transport. Texting as ${this.from}. Use "/as <phone>" to switch.`);
    rl.on("line", async (line) => {
      const text = line.trim();
      if (!text) return;
      if (text.startsWith("/as ")) {
        this.from = text.slice(4).trim();
        console.log(`Now texting as ${this.from}`);
        return;
      }
      await onText({ from: this.from, text });
    });
  }

  async send(to: string, text: string) {
    console.log(`\n[agent -> ${to}] ${text}\n`);
  }
}
