/**
 * Photon 2.0 REST API (https://photon.codes/docs/beta), plain fetch.
 * Convex env: PHOTON_API_KEY (pho_sk_...) and PHOTON_PROJECT_ID (pho_prj_...).
 */

const API = "https://api.photon.codes";

export function photonConfigured() {
  return Boolean(process.env.PHOTON_API_KEY && process.env.PHOTON_PROJECT_ID);
}

export type PhotonInbound = {
  id: string;
  createdAt: string;
  from: string; // sender phone or Apple ID email
  spaceId: string;
  agentUserId: string;
  text?: string;
};

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}/v1/projects/${process.env.PHOTON_PROJECT_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PHOTON_API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new PhotonError(res.status, await res.text());
  return res.status === 204 ? null : res.json();
}

export class PhotonError extends Error {
  constructor(public status: number, body: string) {
    super(`Photon ${status}: ${body.slice(0, 300)}`);
  }
}

/** Received iMessages created at or after `since` (oldest first). */
export async function receivedSince(since: string): Promise<PhotonInbound[]> {
  const out: PhotonInbound[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ direction: "received", platform: "imessage", order: "asc", pageSize: "100", createdSince: since });
    if (pageToken) q.set("pageToken", pageToken);
    const data = (await call("GET", `/messages?${q}`)) as {
      items: {
        id: string;
        createdAt: string;
        status: string;
        content: { type: string; text?: string };
        sentBy?: { handle?: string };
        receivedBy?: { id: string };
        space: { id: string };
      }[];
      nextPageToken?: string;
    };
    for (const m of data.items) {
      if (m.status !== "received" || !m.sentBy?.handle || !m.receivedBy?.id) continue;
      out.push({
        id: m.id,
        createdAt: m.createdAt,
        from: m.sentBy.handle,
        spaceId: m.space.id,
        agentUserId: m.receivedBy.id,
        text: m.content.type === "text" ? m.content.text : undefined,
      });
    }
    if (!data.nextPageToken || data.items.length === 0) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

export async function sendText(spaceId: string, agentUserId: string, text: string, idempotencyKey: string) {
  await call(
    "POST",
    "/messages",
    { spaceId, senderId: agentUserId, content: { type: "text", format: "plain", text } },
    { "idempotency-key": idempotencyKey },
  );
}

/** Compare handles by digits so "+1 (415) 555..." and "+1415555..." match. */
export function normalizeHandle(handle: string) {
  return handle.includes("@") ? handle.toLowerCase() : handle.replace(/[^\d+]/g, "");
}
