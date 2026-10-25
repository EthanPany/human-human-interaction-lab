# Backend

Two pieces:

* `convex/`: database, live queries for badge state, mutations, Claude actions, crons
* `agent/`: text message agent worker (Photon Spectrum for iMessage, Claude for replies). Subscribes to the Convex `outbox` table and sends texts; replies to incoming texts.

## Setup

```bash
cd backend
npm install
npx convex dev          # logs in, creates the deployment, writes CONVEX_URL
cp .env.example .env.local   # then fill ANTHROPIC_API_KEY and PHOTON_* values
bun run agent/index.ts  # in a second terminal
```

The phone number is the account. Passwords are optional and stored as plain text for the demo only.
