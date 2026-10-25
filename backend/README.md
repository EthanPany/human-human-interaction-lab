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
