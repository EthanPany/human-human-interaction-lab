# SpacetimeDB backend

**This is the live backend.** The iOS app uses only this module (database `hhil` on Maincloud), and the iMessage text agent runs here. Convex (`backend/convex`) is turned off: its crons are removed and its `PHOTON_*` env is unset, so it never answers texts. Its data is kept but not used.

It is a port of `backend/convex` as a SpacetimeDB TypeScript module, with the same function names and JSON shapes.

```
spacetime/
├── src/index.ts        module entry: schedule tables (crons), admin reducers
├── src/schema.ts       tables (private) and env declarations
├── src/http.ts         the HTTP API the app calls (rpc, upload, photo)
├── src/api/            ports of backend/convex/*.ts (same names, same JSON)
├── src/lib/            constants.ts: distance rules and tuning knobs (SpacetimeDB only now, keep in step with the app's BadgeStore)
│                       scoring, avatar, phone: copied from backend/convex/lib (npm run sync-lib)
│                       claude, jev, photonApi, agentCore, agentPhoto: synchronous ports for procedures
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

Updating later: `spacetime publish hhil --server maincloud` keeps data and stored env values. To publish with every key from `backend/.env.local` without printing them: `set -a; source ../backend/.env.local; set +a; spacetime publish hhil --server maincloud`. If a publish adds a recurring job, run `spacetime call hhil ensure_jobs --server maincloud`.

### Environment (all optional)

Set in the shell when publishing (as above), or later without uploading: `ANTHROPIC_API_KEY=... spacetime publish hhil --server maincloud --env-only`.

| Key | What |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude matching (tags and reasons), summaries and the text agent. Without it: keyword matching, transcript snippets as summaries. |
| `CLAUDE_MODEL` | Defaults to `claude-sonnet-5-5`. |
| `TYPESAFE_API_KEY` | TypeSafe Jev pair scoring (`src/lib/jev.ts`): Jev scores are saved first, then Claude adds tags and reasons. Without it Claude scores alone. |
| `JEV_MODEL` | Defaults to `jev-latest`. |
| `PHOTON_API_KEY`, `PHOTON_PROJECT_ID` | Turns on the iMessage agent (every 5 s), Photon line assignment on every sign in, and the agent's contact card on first contact. Only one backend may run the agent per Photon line (Convex has these unset). |
| `PUBLIC_BASE_URL` | Host for photo links, if the one derived from requests is wrong (e.g. `https://maincloud.spacetimedb.com`). |

## Admin

```bash
spacetime call hhil seed_demo --server maincloud
spacetime call hhil rescore --server maincloud
spacetime call hhil end_event --server maincloud     # recaps and "you passed by" intros
spacetime logs hhil --server maincloud
spacetime call hhil photon_backfill --server maincloud            # check everyone's Photon line
spacetime call hhil photon_set_line '"+1585..."' '"+1415..."' --server maincloud   # dedicated line for one person
spacetime call hhil send_card '"+1585..."' --server maincloud     # resend the agent's contact card
spacetime sql hhil "SELECT name, phone FROM users" --server maincloud
```

## Local

```bash
spacetime start --in-memory
spacetime publish hhil --server local
SPACETIME_HOST=http://127.0.0.1:3000 npm run e2e
```

In the app, set the host to `http://<your Mac's IP>:3000` (plain http works only for local network addresses).

## Encounters and distance rules

The numbers live in `src/lib/constants.ts` and in the app's `BadgeStore` (keep both in step).

- A badge reacts from the maximum ranging range, about 9 m (50 m when both phones range with extended UWB; the phone says so in `nearby:reportDistance` as `extended`). Each person can lower it with "Respond from" (Settings > Nearby, `respondFromM` in `users:updateProfile`, stored in `user_prefs`). A pair uses the smaller of the two, so both badges react at the same distance. Closeness (tint, glow, approach cues) ramps from that range down to 1 m.
- Together at 1.0 m or closer; once together, apart only past 1.5 m. Together for a second starts an encounter (a `conversations` row plus its `encounters` row), for any two badge wearers, match or not. `badge:state` says `matched`; only matches get tint, glow and approach cues.
- Back together within 5 minutes after parting continues the same encounter (same record, the transcript appends). Later, it is a new encounter, and `people:detail` lists each one in `encounters` with its own summary and follow up.
- "Drop short encounters" (`dropShortEncounters`, on by default): when an encounter ends under 1 minute, it is hidden from whoever has it on (no record, summary or text for them). Hidden for both, it is deleted once it can no longer be rejoined.
- California mode: if either person has it on, recording waits until both said yes (`conversations:consent`; `badge:state` returns `consentRequired`, `myConsent`, `peerConsent`, `recordingAllowed`).
- `nearby:peers` is ordered by priority (the person I'm with, then matches, then others by recency) and says `isMatch`; the phone ranges with the first few (UWB sessions are limited).

## Differences from Convex

- Same: sign in, profile, avatar defaults, photos and moments, Nearby tokens, distances, badge state, conversations (open, finish, stale cleanup, summaries), People list/detail/current, heads up texts, end of event, Jev scoring with Claude tags and reasons and the keyword fallback, the Photon text agent (first text greeting, contact card, held texts until they first write in), Photon 2.0 per user line assignment on every sign in (`users:me` returns `agentLine` and `agentConnected`).
- Each person's Photon line lives in the `agent_lines` table (Convex: `users.agentLine`), and the sign up welcome is marked in `welcome_texts` (Convex: `outbox.kind`).
- Jev rates candidates one after another (fetch is synchronous in procedures), not eight at a time.
- No per match badge keywords yet (Convex `matches.keywords`).
- Photos are stored inline in a `photos` table (bytes) and served by the module, so no separate file storage is needed.
- No Voyage embedding prefilter (no vector index). With more than 24 profiled people, the most recently active 24 are scored per viewer.
- Updates reach the app by polling (about 1 s), not pushed live queries.
- The local text agent worker (`backend/agent`) only speaks Convex; on Spacetime use the in-database agent.
- The two backends have separate data. Accounts do not move between them.
