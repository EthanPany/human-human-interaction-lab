import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { IncomingText, Transport } from "./transport";

type App = Awaited<ReturnType<typeof Spectrum>>;
type Space = Parameters<App["send"]>[0];

/**
 * Real iMessage through Photon Spectrum Cloud.
 * Needs PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET (Photon dashboard, Spectrum project).
 */
export class PhotonTransport implements Transport {
  readonly name = "photon";
  private app?: App;
  private spaces = new Map<string, Space>(); // phone -> chat, reused for replies

  constructor(private projectId: string, private projectSecret: string) {}

  async start(onText: (msg: IncomingText) => Promise<void>) {
    this.app = await Spectrum({
      projectId: this.projectId,
      projectSecret: this.projectSecret,
      providers: [imessage.config()],
    });
    const app = this.app;

    // Read messages in the background; each handler runs without blocking the loop.
    (async () => {
      for await (const [space, message] of app.messages) {
        if (message.sender?.kind === "agent") continue; // our own messages
        const from = message.sender?.id;
        const content = message.content;
        if (!from || content.type !== "text") continue;
        this.spaces.set(from, space);
        onText({ from, text: content.text }).catch((e) => console.error("handler failed", e));
      }
    })().catch((e) => console.error("Photon message loop stopped", e));
  }

  async send(to: string, text: string) {
    if (!this.app) throw new Error("Photon transport not started");
    let space = this.spaces.get(to);
    if (!space) {
      space = (await imessage(this.app).space.create(to)) as unknown as Space;
      this.spaces.set(to, space);
    }
    await space.send(text);
  }
}
