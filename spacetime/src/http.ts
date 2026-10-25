import { Router, SyncResponse, type Request } from "spacetimedb/server";
import spacetimedb from "./schema";
import { UserError } from "./lib/db";
import { ArgError, type ApiFn, type Ctx } from "./api/context";
import * as users from "./api/users";
import * as badge from "./api/badge";
import * as nearby from "./api/nearby";
import * as conversations from "./api/conversations";
import * as people from "./api/people";
import * as agent from "./api/agent";
import { resetTestPair } from "./api/testing";
import { num, optStr, str } from "./api/context";

/**
 * The HTTP API the iOS app (and scripts/e2e.mjs) uses. SpacetimeDB has no
 * Swift SDK, so instead of reducers + subscriptions the app calls these routes:
 *
 *   POST {host}/v1/database/{db}/route/rpc     {"path": "users:signIn", "args": {...}}
 *        -> 200 {"value": ...} | 400 {"error": "..."}
 *   POST {host}/v1/database/{db}/route/upload  raw JPEG body -> {"storageId": "..."}
 *   GET  {host}/v1/database/{db}/route/photo?id=...         -> the image
 *
 * Function paths and JSON shapes are the same as the Convex functions
 * (backend/convex/*.ts), so the app's models decode both. Live queries become
 * polling: the app calls the query paths about once a second.
 */

const FUNCTIONS: Record<string, ApiFn> = {
  "users:signIn": users.signIn,
  "users:me": users.me,
  "users:updateProfile": users.updateProfile,
  "users:heartbeat": users.heartbeat,
  "users:setPhoto": users.setPhoto,
  "users:moments": users.moments,
  "users:addMoment": users.addMoment,
  "users:removeMoment": users.removeMoment,
  "badge:state": badge.state,
  "nearby:peers": nearby.peers,
  "nearby:uploadToken": nearby.uploadToken,
  "nearby:reportDistance": nearby.reportDistance,
  "nearby:setRanging": nearby.setRanging,
  "conversations:finish": conversations.finish,
  "people:list": people.list,
  "people:detail": people.detail,
  "people:met": people.met,
  "people:current": people.current,
  // The text agent API (backend/convex/agent.ts), keyed by phone. No auth: demo only.
  "agent:context": ({ tx }, a) => agent.context(tx, str(a, "phone")),
  "agent:ensureUser": ({ tx }, a) => agent.ensureUser(tx, str(a, "phone")),
  "agent:saveProfile": ({ tx }, a) => agent.saveProfile(tx, str(a, "phone"), a.patch as Record<string, unknown>),
  "agent:confirmContact": ({ tx }, a) => agent.confirmContact(tx, str(a, "phone")),
  "agent:addFeedback": ({ tx }, a) =>
    agent.addFeedback(tx, str(a, "phone"), str(a, "note"), a.rating === undefined ? undefined : num(a, "rating"), optStr(a, "otherName")),
  "agent:updateRubricNotes": ({ tx }, a) => agent.updateRubricNotes(tx, str(a, "notes")),
  "testing:resetTestPair": resetTestPair,
};

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function json(body: unknown, status = 200) {
  return new SyncResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function errorResponse(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const expected = e instanceof UserError || e instanceof ArgError;
  if (!expected) console.error("request failed", e);
  return json({ error: message }, expected ? 400 : 500);
}

/** Where this database's routes live, e.g. https://maincloud.spacetimedb.com/v1/database/<id>/route */
function routeBase(req: Request, publicBase: string | undefined) {
  const uri = req.uri;
  const i = uri.indexOf("/route/");
  let base = i >= 0 ? uri.slice(0, i + "/route".length) : uri;
  const m = /^(https?):\/\/([^/]+)(\/.*)$/.exec(base);
  if (!m) return base;
  let [, scheme, host, path] = m;
  if (publicBase) {
    return publicBase.replace(/\/+$/, "") + path;
  }
  const local = /^(localhost|127\.|10\.|192\.168\.|\[::1\]|[^.]+\.local)/.test(host) || !host.includes(".");
  if (scheme === "http" && !local) scheme = "https";
  return `${scheme}://${host}${path}`;
}

function queryParam(uri: string, key: string) {
  const q = uri.split("?")[1] ?? "";
  for (const part of q.split("&")) {
    const [k, v] = part.split("=");
    if (decodeURIComponent(k ?? "") === key) return decodeURIComponent(v ?? "");
  }
  return undefined;
}

export const rpc = spacetimedb.httpHandler((ctx, req) => {
  try {
    let body: { path?: unknown; args?: unknown };
    try {
      body = req.json();
    } catch {
      throw new ArgError("Body must be JSON");
    }
    const path = typeof body.path === "string" ? body.path : "";
    const fn = FUNCTIONS[path];
    if (!fn) return json({ error: `Unknown function ${path}` }, 404);
    const args = (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>;
    const base = routeBase(req, ctx.env.PUBLIC_BASE_URL);
    const value = ctx.withTx((tx) => {
      const c: Ctx = { tx, photoUrl: (id) => (id ? `${base}/photo?id=${id}` : null) };
      return fn(c, args);
    });
    return json({ value: value ?? null });
  } catch (e) {
    return errorResponse(e);
  }
});

export const upload = spacetimedb.httpHandler((ctx, req) => {
  try {
    const data = req.bytes();
    if (data.length === 0) throw new ArgError("Empty upload");
    if (data.length > MAX_UPLOAD_BYTES) throw new UserError("That photo is too big.");
    const contentType = req.headers.get("content-type") || "image/jpeg";
    const storageId = ctx.withTx((tx) => users.storePhoto(tx, data, contentType));
    return json({ storageId });
  } catch (e) {
    return errorResponse(e);
  }
});

export const photo = spacetimedb.httpHandler((ctx, req) => {
  const id = queryParam(req.uri, "id");
  const row = id ? ctx.withTx((tx) => tx.db.photos.id.find(id)) : null;
  if (!row) return new SyncResponse("Not found", { status: 404 });
  return new SyncResponse(row.data, {
    headers: { "content-type": row.contentType, "cache-control": "public, max-age=31536000, immutable" },
  });
});

export const health = spacetimedb.httpHandler(() => json({ ok: true }));

export const router = spacetimedb.httpRouter(
  new Router().post("/rpc", rpc).post("/upload", upload).get("/photo", photo).get("/health", health),
);
