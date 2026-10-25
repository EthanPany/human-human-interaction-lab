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
export async function openDirect(agentHandle: string, personHandle: string) {
  const user = async (handle: string) =>
    ((await call("POST", "/users", { handle, platform: "imessage" })) as { id: string }).id;
  const [agentUserId, personId] = [await user(agentHandle), await user(personHandle)];
  const space = (await call(
    "POST",
    "/spaces",
    { platform: "imessage", participantIds: [agentUserId, personId] },
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
