# Human Human Interaction Lab

Cal Hacks 13.0 project. Your phone becomes a live name badge worn on a lanyard, and a text message agent helps you meet the right people at an event. Before the event the agent learns who you are and who you want to meet; during the event your badge glows and surfaces the tag a nearby match cares about most; after the event the agent texts you summaries, follow ups and intros.

**Design, plans and submission notes:** [Figma file](https://www.figma.com/design/fT0XfUlJq0W47Z33XfjnYY/Cal-Hack-13)

## Repo layout

| Folder | What lives there |
|---|---|
| `ios/` | SwiftUI app (git submodule, separate repo managed by Xcode) |
| `backend/` | Convex backend and the text message agent worker |
| `poster/` | Poster source files and exports |
| `video/` | Demo video footage, edits and exports |

Clone with submodules:

```bash
git clone --recurse-submodules https://github.com/EthanPany/human-human-interaction-lab.git
```

## How we use Convex

Convex is the live heart of the badge. Everything the phone shows is a subscription, so when two people walk toward each other the badge changes within a moment, with no polling code in the app.

- **Live queries.** The iOS app (`ios/HHIL/Core/Services/ConvexBackend.swift`) subscribes to `badge:state` (what your badge shows right now: glow strength, the matched person, their keywords), `nearby:peers` (whose phones to range with over Ultra Wideband, and the discovery tokens they published for you), `users:me`, `users:moments`, `people:list` and `people:detail`. A distance reported by one phone (`nearby:report`) updates the other person's badge through the same subscription.
- **Outbox subscription.** Texts the agent should send (heads ups, "save their contact?", recaps, intros) are rows in the `outbox` table. The local agent worker subscribes to `outbox:pending` (`backend/agent/outbox.ts`) and delivers each one exactly once; the cloud agent drains the same table on its tick.
- **File storage.** Profile photos and event "moments" are uploaded straight from the phone with `users:generateUploadUrl` and served with `ctx.storage.getUrl`.
- **Crons** (`backend/convex/crons.ts`): heads up texts about strong matches who are at the event (every minute), closing conversations whose phones went quiet (every minute), and the cloud text agent tick (every 5 seconds) that reads new iMessages, answers them with Claude and sends queued texts.
- **Actions and the scheduler.** Match scoring calls Claude and embeddings from actions; sign up schedules the agent line assignment with `ctx.scheduler.runAfter`.

The same app also runs on SpacetimeDB (`spacetime/`), switchable in Settings, with the same function names.
