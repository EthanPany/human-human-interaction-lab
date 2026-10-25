import { randomUUID } from "node:crypto";
import type { IncomingText, Transport } from "./transport";

/**
 * iMessage through Photon 2.0 (beta dashboard, app.beta.photon.codes), using the
 * REST API directly: https://photon.codes/docs/beta
 *
 * Needs PHOTON_PROJECT_ID (pho_prj_...) and PHOTON_API_KEY (pho_sk_..., with
 * project:read and project:write).
 *
 * Shared line rules (beta): each person must be added to the line in the
 * dashboard, and must text the agent once after that before the agent can text
 * them. So people start the conversation; after that heads ups and recaps work.
 */

const API = process.env.PHOTON_API_URL ?? "https://api.photon.codes";
const POLL_MS = 2_000;

type Snapshot = { id: string; handle?: string };
type ReceivedMessage = {
  id: string;
  createdAt: string;
  platform: string;
  status: string;
  content: { type: string; text?: string };
  sentBy: Snapshot;
  receivedBy?: Snapshot;
  space: { id: string; kind?: string };
};
type Conversation = { spaceId: string; agentUserId: string; lastMessageId: string };

export class Photon2Transport implements Transport {
  readonly name = "photon2";
  /** phone (or Apple ID email) -> where to reply */
  private conversations = new Map<string, Conversation>();
  private seen = new Set<string>();
  private cursor = new Date(Date.now() - 24 * 3600_000).toISOString();

  constructor(private projectId: string, private apiKey: string) {}

  async start(onText: (msg: IncomingText) => Promise<void>) {
    // Learn existing conversations from the last day so the agent can text
    // people who wrote before a restart, without answering those old texts.
    await this.poll(async () => undefined);
    this.cursor = new Date().toISOString();

    const loop = async () => {
      try {
        await this.poll(onText);
      } catch (e) {
        console.error("Photon poll failed", e instanceof Error ? e.message : e);
      }
      setTimeout(loop, POLL_MS);
    };
    void loop();
  }

  async send(to: string, text: string) {
    const conversation = this.conversations.get(normalize(to));
    if (!conversation) {
      throw new Error(`No conversation with ${to} yet: they need to text the agent first (Photon shared line)`);
    }
    await this.request("POST", `/v1/projects/${this.projectId}/messages`, {
      headers: { "idempotency-key": randomUUID() },
      body: {
        spaceId: conversation.spaceId,
        senderId: conversation.agentUserId,
        content: { type: "text", format: "plain", text },
      },
    });
  }

  // MARK: Internals

  private async poll(onText: (msg: IncomingText) => Promise<void>) {
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        direction: "received",
        platform: "imessage",
        order: "asc",
        pageSize: "100",
        createdSince: this.cursor,
      });
      if (pageToken) query.set("pageToken", pageToken);
      const page = (await this.request("GET", `/v1/projects/${this.projectId}/messages?${query}`)) as {
        items: ReceivedMessage[];
        nextPageToken?: string;
      };
      for (const m of page.items) {
        if (this.seen.has(m.id) || m.status !== "received") continue;
        this.seen.add(m.id);
        if (m.createdAt > this.cursor) this.cursor = m.createdAt;
        const from = m.sentBy?.handle;
        if (!from || !m.receivedBy?.id) continue;
        this.conversations.set(normalize(from), {
          spaceId: m.space.id,
          agentUserId: m.receivedBy.id,
          lastMessageId: m.id,
        });
        if (m.content.type === "text" && m.content.text) {
          onText({ from, text: m.content.text }).catch((e) => console.error("handler failed", e));
        }
      }
      pageToken = page.nextPageToken && page.items.length > 0 ? page.nextPageToken : undefined;
    } while (pageToken);
  }

  private async request(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      throw new Error("Photon rate limited, backing off");
    }
    if (!res.ok) throw new Error(`Photon ${method} ${path.split("?")[0]} → ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
}

/** Compare phone numbers by digits so "+1 (415) 555..." and "+1415555..." match. */
function normalize(handle: string) {
  return handle.includes("@") ? handle.toLowerCase() : handle.replace(/[^\d+]/g, "");
}
