import { TimeDuration } from "spacetimedb";
import type { HttpClient } from "./httpClient";

/**
 * Photon 2.0 REST API, synchronous port of convex/lib/photonApi.ts.
 * Env: PHOTON_API_KEY (pho_sk_...) and PHOTON_PROJECT_ID (pho_prj_...).
 */

const API = "https://api.photon.codes";

export type PhotonEnv = { PHOTON_API_KEY?: string; PHOTON_PROJECT_ID?: string };

export function photonConfigured(env: PhotonEnv) {
  return Boolean(env.PHOTON_API_KEY && env.PHOTON_PROJECT_ID);
}

export type PhotonInbound = {
  id: string;
  createdAt: string;
  from: string;
  spaceId: string;
  agentUserId: string;
  text?: string;
};

export class PhotonError extends Error {
  constructor(public status: number, body: string) {
    super(`Photon ${status}: ${body.slice(0, 300)}`);
  }
}

function call(http: HttpClient, env: PhotonEnv, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = http.fetch(`${API}/v1/projects/${env.PHOTON_PROJECT_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.PHOTON_API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    timeout: TimeDuration.fromMillis(20_000),
  });
  if (!res.ok) throw new PhotonError(res.status, res.text());
  return res.status === 204 ? null : res.json();
}

/** Received iMessages created at or after `since` (oldest first). */
export function receivedSince(http: HttpClient, env: PhotonEnv, since: string): PhotonInbound[] {
  const out: PhotonInbound[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const q = [
      ["direction", "received"],
      ["platform", "imessage"],
      ["order", "asc"],
      ["pageSize", "100"],
      ["createdSince", since],
      ...(pageToken ? [["pageToken", pageToken]] : []),
    ]
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const data = call(http, env, "GET", `/messages?${q}`) as {
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

export function sendText(http: HttpClient, env: PhotonEnv, spaceId: string, agentUserId: string, text: string, idempotencyKey: string) {
  call(
    http,
    env,
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
