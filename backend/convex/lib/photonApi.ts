/**
 * Photon 2.0 REST API (https://photon.codes/docs/beta), plain fetch.
 * Convex env: PHOTON_API_KEY (pho_sk_...) and PHOTON_PROJECT_ID (pho_prj_...).
 */

const API = "https://api.photon.codes";

/**
 * Photon 2.0 beta lines are in use. Setting AGENT_MODE=spectrum (each person's
 * line set with photonAssign:setLine) or AGENT_LINE (one line for all) means
 * a dedicated Photon Spectrum line runs instead (backend/agent, npm run agent),
 * so the cloud tick and line assignment stand down.
 */
export function photonConfigured() {
  if (process.env.AGENT_LINE || process.env.AGENT_MODE === "spectrum") return false;
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

/**
 * The project's own SMS number (SMS_LINE in the Convex env, E.164). When set,
 * everyone texts that number, and the agent can text first.
 */
export function smsLine() {
  return process.env.SMS_LINE || undefined;
}

/** Received texts (iMessage, plus SMS when SMS_LINE is set) at or after `since`, oldest first. */
export async function receivedSince(since: string): Promise<PhotonInbound[]> {
  const platforms = smsLine() ? ["imessage", "sms"] : ["imessage"];
  const all = (await Promise.all(platforms.map((p) => receivedOn(p, since)))).flat();
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function receivedOn(platform: string, since: string): Promise<PhotonInbound[]> {
  const out: PhotonInbound[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ direction: "received", platform, order: "asc", pageSize: "100", createdSince: since });
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

/** Show "..." in their thread while Claude thinks. Best effort. */
export async function setTyping(spaceId: string, agentUserId: string, typing: boolean) {
  try {
    await call("POST", `/spaces/${spaceId}/typing`, { senderId: agentUserId, typing });
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
export async function openDirect(agentHandle: string, personHandle: string, platform: "imessage" | "sms" = "imessage") {
  const user = async (handle: string) =>
    ((await call("POST", "/users", { handle, platform })) as { id: string }).id;
  const [agentUserId, personId] = [await user(agentHandle), await user(personHandle)];
  const space = (await call(
    "POST",
    "/spaces",
    { platform, participantIds: [agentUserId, personId] },
    { "idempotency-key": `direct:${agentUserId}:${personId}` },
  )) as { id: string };
  return { spaceId: space.id, agentUserId };
}

/** Photon refuses a first text on a shared line until the person writes in. */
export function needsInboundFirst(e: unknown) {
  return e instanceof PhotonError && e.message.includes("SHARED_LINE_INBOUND_REQUIRED");
}

/** Compare handles by digits so "+1 (415) 555..." and "+1415555..." match. */
export function normalizeHandle(handle: string) {
  return handle.includes("@") ? handle.toLowerCase() : handle.replace(/[^\d+]/g, "");
}

/**
 * Put a person on the project's shared iMessage pool and return the line they
 * should text (E.164). Idempotent per handle, so calling again is safe.
 */
export async function assignLine(handle: string): Promise<string | undefined> {
  const data = (await call("POST", "/platforms/imessage/assignments", { handle }, {
    "Idempotency-Key": `assign:${handle}`,
  })) as { assignedPhoneNumber?: string; assignment?: { assignedPhoneNumber?: string } } | null;
  return data?.assignedPhoneNumber ?? data?.assignment?.assignedPhoneNumber;
}

/** Existing assignment for a handle, if any. */
export async function lineFor(handle: string): Promise<string | undefined> {
  const data = (await call("GET", "/platforms/imessage/assignments")) as {
    assignments: { handle: string; assignedPhoneNumber: string }[];
  };
  return data.assignments.find((a) => a.handle === handle)?.assignedPhoneNumber;
}

/** Upload a file (multipart/related: JSON metadata, then the bytes). Returns the attachment id. */
export async function uploadAttachment(bytes: Uint8Array, contentType: string, filename: string, idempotencyKey: string) {
  const boundary = `hhil${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      JSON.stringify({ contentType, sizeBytes: bytes.length, filename }) +
      `\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const res = await fetch(`${API}/v1/projects/${process.env.PHOTON_PROJECT_ID}/attachments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PHOTON_API_KEY}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
      "idempotency-key": idempotencyKey,
    },
    body,
  });
  if (!res.ok) throw new PhotonError(res.status, await res.text());
  return ((await res.json()) as { id: string }).id;
}

export async function sendAttachment(spaceId: string, agentUserId: string, attachmentId: string, idempotencyKey: string) {
  await call(
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
