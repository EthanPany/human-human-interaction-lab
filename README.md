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
