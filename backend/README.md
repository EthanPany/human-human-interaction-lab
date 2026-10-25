# Backend

```
backend/
├── convex/                 Convex backend (runs in Convex, live queries to the app)
│   ├── schema.ts           data model
│   ├── users.ts            sign in with phone number, profile
│   ├── nearby.ts           UWB discovery tokens and distance reports
│   ├── badge.ts            live badge state (glow, color, front tag, talking)
│   ├── matching.ts         reciprocal matching with Claude, rubric
│   ├── conversations.ts    transcripts, Claude summaries and follow ups
│   ├── people.ts           CRM list, detail, current person (iPhone Duo)
│   ├── agent.ts            API used by the text agent worker
│   ├── notify.ts           heads up texts (cron)
│   ├── event.ts            end of event recaps and "you passed by" intros
│   ├── outbox.ts           texts waiting for the worker
│   ├── seed.ts             demo attendees
│   └── lib/                pure helpers: scoring, pairs, phone, Claude client, constants
└── agent/                  text agent worker (runs on your Mac)
    ├── index.ts            wiring
    ├── brain.ts            Claude with tools
    ├── outbox.ts           delivers queued texts
    └── transports/         photon (iMessage) and console (terminal)
```

## First run

```bash
cd backend
npm install
npx convex dev                   # log in, create the project; keeps running and syncing
cp .env.example .env.local       # Convex already wrote CONVEX_URL; add the other keys
npx convex env set ANTHROPIC_API_KEY <your key>   # so Convex functions can call Claude
npm run seed                     # demo attendees + first matching pass
npm run agent:console            # chat with the agent in the terminal
npm run agent                    # real iMessage through Photon
```

At the end of the demo: `npm run end-event` sends recaps and intros.

## Notes

* The phone number is the account. Passwords are optional and stored as plain text, demo only.
* Seeded people use fictional 555-01xx numbers and are never texted.
* Tuning knobs (distances, cooldowns, default rubric) live in `convex/lib/constants.ts`.


## Testing

`npm run e2e` acts as two phones against the deployment in `.env.local`: sign in, profile, photo upload, scoring, Nearby tokens, approach at 5 m, talking after 10 s at 1 m, transcript, saving by text, People list and detail. It uses fictional 555-01xx numbers, so no real texts go out.

## Optional keys

- `ANTHROPIC_API_KEY` (Convex env and `.env.local`): Claude scoring, summaries and the agent. Without it matching uses the keyword fallback.
- `VOYAGE_API_KEY` (Convex env): semantic prefilter. With a big crowd only the 24 nearest people in both directions (they fit my needs, I fit theirs) go to Claude.
