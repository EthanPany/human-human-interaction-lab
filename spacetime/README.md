# SpacetimeDB backend

The same backend as `backend/convex`, running as a SpacetimeDB TypeScript module, so the demo can switch providers in the iOS app (Settings > Backend provider). Convex stays the default.

```
spacetime/
├── src/index.ts        module entry: schedule tables (crons), admin reducers
├── src/schema.ts       tables (private) and env declarations
├── src/http.ts         the HTTP API the app calls (rpc, upload, photo)
├── src/api/            ports of backend/convex/*.ts (same names, same JSON)
├── src/lib/            constants, scoring, avatar, phone: copied from backend/convex/lib (npm run sync-lib)
│                       claude, photonApi, agentCore: synchronous ports for procedures
└── scripts/e2e.mjs     two fake phones against a database (port of backend/scripts/e2e.ts)
```

## How the app talks to it

There is no Swift SDK, so the app uses module HTTP routes (beta in SpacetimeDB 2.x) instead of reducers and subscriptions:

| Route | Body | Returns |
| --- | --- | --- |
| `POST /v1/database/<db>/route/rpc` | `{"path": "users:signIn", "args": {...}}` | `{"value": ...}` or `{"error": "..."}` (400) |
| `POST /v1/database/<db>/route/upload` | raw JPEG | `{"storageId": "..."}` |
| `GET  /v1/database/<db>/route/photo?id=...` | | the image |
| `GET  /v1/database/<db>/route/health` | | `{"ok": true}` |

`path` is the Convex function name (`users:me`, `badge:state`, `nearby:reportDistance`, `people:detail`, ...), and the values have the same JSON shapes. Each call runs in one transaction. Convex live queries become polling: the app asks again about once a second.

## Deploy to Maincloud

```bash
curl -sSf https://install.spacetimedb.com | sh   # installs the spacetime CLI
spacetime login                                  # opens the browser
cd spacetime
npm install
ANTHROPIC_API_KEY=sk-ant-... spacetime publish hhil --server maincloud
spacetime call hhil seed_demo --server maincloud   # demo attendees + first matching pass
```

Pick another database name if `hhil` is taken; the app needs it. Check with `SPACETIME_DB=hhil npm run e2e` (two fake phones, takes about a minute).

Updating later: `spacetime publish hhil --server maincloud` keeps data and stored env values. If a publish adds a recurring job, run `spacetime call hhil ensure_jobs --server maincloud`.

### Environment (all optional)

Set in the shell when publishing (as above), or later without uploading: `ANTHROPIC_API_KEY=... spacetime publish hhil --server maincloud --env-only`.

| Key | What |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude matching, summaries and the text agent. Without it: keyword matching, transcript snippets as summaries. |
| `CLAUDE_MODEL` | Defaults to `claude-sonnet-5-5`. |
| `PHOTON_API_KEY`, `PHOTON_PROJECT_ID` | Turns on the iMessage agent (every 5 s). Only one backend may run the agent per Photon line: unset these in Convex first, or texts are answered twice. |
| `PUBLIC_BASE_URL` | Host for photo links, if the one derived from requests is wrong (e.g. `https://maincloud.spacetimedb.com`). |

## Admin

```bash
spacetime call hhil seed_demo --server maincloud
spacetime call hhil rescore --server maincloud
spacetime call hhil end_event --server maincloud     # recaps and "you passed by" intros
spacetime logs hhil --server maincloud
spacetime sql hhil "SELECT name, phone FROM users" --server maincloud
```

## Local

```bash
spacetime start --in-memory
spacetime publish hhil --server local
SPACETIME_HOST=http://127.0.0.1:3000 npm run e2e
```

In the app, set the host to `http://<your Mac's IP>:3000` (plain http works only for local network addresses).

## Differences from Convex

- Same: sign in, profile, avatar defaults, photos and moments, Nearby tokens, distances, badge state, conversations (open, finish, stale cleanup, summaries), People list/detail/current, heads up texts, end of event, Claude matching with the keyword fallback, the Photon text agent.
- Photos are stored inline in a `photos` table (bytes) and served by the module, so no separate file storage is needed.
- No Voyage embedding prefilter (no vector index). With more than 24 profiled people, the most recently active 24 are scored per viewer.
- Updates reach the app by polling (about 1 s), not pushed live queries.
- The local text agent worker (`backend/agent`) only speaks Convex; on Spacetime use the in-database agent.
- The two backends have separate data. Accounts do not move between them.
