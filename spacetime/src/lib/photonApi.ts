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

/** Show "..." in their thread while Claude thinks. Best effort. */
export function setTyping(http: HttpClient, env: PhotonEnv, spaceId: string, agentUserId: string, typing: boolean) {
  try {
    call(http, env, "POST", `/spaces/${spaceId}/typing`, { senderId: agentUserId, typing });
  } catch {
    // cosmetic only
  }
}

/**
 * Open (or reuse) the direct thread between an agent line and a person, so the
 * agent can text first. Works on a dedicated line. On the shared pool Photon
 * creates the space, but sending into it fails with SHARED_LINE_INBOUND_REQUIRED
 * until the person has texted the line once.
 */
export function openDirect(http: HttpClient, env: PhotonEnv, agentHandle: string, personHandle: string, platform: "imessage" | "sms" = "imessage") {
  const user = (handle: string) => (call(http, env, "POST", "/users", { handle, platform }) as { id: string }).id;
  const agentUserId = user(agentHandle);
  const personId = user(personHandle);
  const space = call(
    http,
    env,
    "POST",
    "/spaces",
    { platform, participantIds: [agentUserId, personId] },
    { "idempotency-key": `direct:${agentUserId}:${personId}` },
  ) as { id: string };
  return { spaceId: space.id, agentUserId };
}

/** Photon refuses a first text on a shared line until the person writes in. */
export function needsInboundFirst(e: unknown) {
  return e instanceof PhotonError && e.message.includes("SHARED_LINE_INBOUND_REQUIRED");
}

/**
 * Put a person on the project's shared iMessage pool and return the line they
 * should text (E.164). Idempotent per handle, so calling again is safe.
 */
export function assignLine(http: HttpClient, env: PhotonEnv, handle: string): string | undefined {
  const data = call(http, env, "POST", "/platforms/imessage/assignments", { handle }, {
    "Idempotency-Key": `assign:${handle}`,
  }) as { assignedPhoneNumber?: string; assignment?: { assignedPhoneNumber?: string } } | null;
  return data?.assignedPhoneNumber ?? data?.assignment?.assignedPhoneNumber;
}

/** Existing assignment for a handle, if any. */
export function lineFor(http: HttpClient, env: PhotonEnv, handle: string): string | undefined {
  const data = call(http, env, "GET", "/platforms/imessage/assignments") as {
    assignments: { handle: string; assignedPhoneNumber: string }[];
  };
  return data.assignments.find((a) => a.handle === handle)?.assignedPhoneNumber;
}

/** ASCII/UTF-8 bytes without relying on TextEncoder in the module runtime. */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}


/** Upload a file (multipart/related: JSON metadata, then the bytes). Returns the attachment id. */
export function uploadAttachment(http: HttpClient, env: PhotonEnv, bytes: Uint8Array, contentType: string, filename: string, idempotencyKey: string) {
  // Fixed boundary (no Math.random in the module): it never appears in a vCard or base64.
  const boundary = "hhil-attachment-boundary-7f3a9c";
  const head = utf8(
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      JSON.stringify({ contentType, sizeBytes: bytes.length, filename }) +
      `\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = utf8(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const res = http.fetch(`${API}/v1/projects/${env.PHOTON_PROJECT_ID}/attachments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.PHOTON_API_KEY}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
      "idempotency-key": idempotencyKey,
    },
    body,
    timeout: TimeDuration.fromMillis(30_000),
  });
  if (!res.ok) throw new PhotonError(res.status, res.text());
  return (res.json() as { id: string }).id;
}

export function sendAttachment(http: HttpClient, env: PhotonEnv, spaceId: string, agentUserId: string, attachmentId: string, idempotencyKey: string) {
  call(
    http,
    env,
    "POST",
    "/messages",
    { spaceId, senderId: agentUserId, content: { type: "attachment", attachmentId } },
    { "idempotency-key": idempotencyKey },
  );
}

/**
 * The agent's contact card (vCard 3.0) for the line this person texts, with
 * its name and headshot, so they can save it with one tap.
 */
export function agentVCard(line: string, photoBase64: string) {
  const fold = (s: string) => s.match(/.{1,74}/g)!.join("\r\n ");
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Agent;Badge;;;",
    "FN:Badge Agent",
    "ORG:Human Human Interaction Lab",
    "NOTE:Your badge agent from Cal Hacks. Text me anytime.",
    `TEL;type=CELL;type=VOICE;type=pref:${line}`,
    fold(`PHOTO;ENCODING=b;TYPE=JPEG:${photoBase64}`),
    "END:VCARD",
    "",
  ].join("\r\n");
}
