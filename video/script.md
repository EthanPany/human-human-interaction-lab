# Human Human Interaction Lab: demo video plan

Cal Hacks 13.0. Target length 2:32 (Figma track cap is 3:00). Devpost needs a YouTube or Vimeo link, submissions close Oct 25 2026, 9:00 AM PDT.

First cut: `/home/claude/video/animatic.mp4` (1920x1080, 30 fps, 2:32, synthesized soft music, no voiceover). Every dark card with a red **FILM** tag is a placeholder for live footage. Cut the footage in over those cards, keep the graphics, record the voiceover on top. If time runs out, the animatic can be uploaded as is.

Flow: phones first, then the problem, then the live demo, then how it works, then the close.

Source key:
* **FILM**: live footage the team shoots tonight
* **SCREEN**: screen recording or screenshot of the real app or the real iMessage thread
* **GFX**: graphic already built in the animatic (or redo in Rotato / Figma)

---

## Timecoded script and shot list

| # | Time | Visual | Voiceover | On screen text | Source |
|---|---|---|---|---|---|
| 1 | 0:00 to 0:08 | Two iPhones float in, tilted in 3D, each showing the worn badge (yellow "Ask me about", blue "Talk to me about"). They turn toward the camera, title lands. | (none, a droplet sound and music) | Human Human Interaction Lab | GFX (Rotato) |
| 2 | 0:08 to 0:14 | Hackathon time lapse: the hall at Cal Hacks, people streaming between tables. | Every event like this is full of people you could learn from. | One room. Hundreds of people you could learn from. | FILM |
| 3 | 0:14 to 0:20 | Kinetic type on cream. | Talking to people, in person, is still how ideas and teams start. | Human to human interaction still matters. | GFX |
| 4 | 0:20 to 0:27 | Dot field: one line connects two dots, every other dot fades out. | But while you are talking to one person, you are not talking to anyone else. | Talk to one person, and you can't talk to anyone else. | GFX |
| 5 | 0:27 to 0:34 | "Every conversation is a gamble." Two stat bars. | So every hello is a gamble. In one study, 95 percent of guests wanted to meet new people, yet about half their conversations were with friends they already knew. | Every conversation is a gamble. 95% wanted to meet new people. ~1/2 of talks were with friends. (Ingram and Morris, 2007) | GFX |
| 6 | 0:34 to 0:39 | Big question card, a filter funnel. | So how do we make it more efficient? The room needs a filter. | What if the room had a filter? | GFX |
| 7 | 0:39 to 0:45 | Close up: phone drops into the 3D printed lanyard holder, someone puts it on. | Meet the Human Human Interaction Lab. Your phone, in a 3D printed holder, becomes a live name badge. | Meet the Human Human Interaction Lab | FILM |
| 8 | 0:45 to 0:53 | Left: iMessage onboarding thread with the agent. Right: app sign in. | You onboard by text. Our iMessage agent, built on Photon, asks who you are and who you want to meet. | 1. Text the agent. It asks who you want to meet. | SCREEN (iMessage rec) + app screenshots |
| 9 | 0:53 to 1:01 | Badge tab, avatar editor, worn badge. | Your badge shows your name, huge, and up to three things to ask you about. | 2. Wear it. Huge name, three big topics. | SCREEN |
| 10 | 1:01 to 1:10 | Heads up text arrives on the lock screen; match card for Maya. | Behind the scenes, Claude scores every pair of attendees in both directions. Only mutual matches surface, and the agent texts you a heads up. | 3. Claude finds mutual matches. You get a heads up. | SCREEN (iMessage rec) |
| 11 | 1:10 to 1:24 | HERO SHOT. Two people with badges walk toward each other across the hall. Inset: real app recording, avatar tints pink to purple to blue, topics flip. | As your match walks closer, measured with Ultra Wideband, both avatars tint toward a shared color and your topics flip to what they want to talk to you about. Soft droplets, and an underwater heartbeat that speeds up as they get close. | 4. As a match walks closer, your avatars tint toward a shared color. | FILM + SCREEN (app rec 1:38 to 1:52) |
| 12 | 1:24 to 1:34 | Badges close up as the two start talking: the avatars hop into each other's badge. | Start talking, and your avatars hop into each other's badge. | 5. Start talking. The avatars hop over. | FILM + SCREEN |
| 13 | 1:34 to 1:44 | iMessage recap with summary and follow up; person detail screen. | When you part ways, the agent texts you a summary and a follow up you can send. | 6. After the talk: a summary and a follow up, by text. | SCREEN (iMessage rec) |
| 14 | 1:44 to 1:51 | People list and a person's timeline. | And your People list keeps everyone you actually met. | Everyone you met, in one place. | SCREEN |
| 15 | 1:51 to 2:05 | Diagram: iPhone ↔ Convex ↔ Claude ↔ Photon, SpacetimeDB beside Convex. | Here is how it works. The iPhone ranges nearby badges with Ultra Wideband and syncs to Convex in real time, with SpacetimeDB as a second backend. Claude scores the matches, and Photon carries the conversation over iMessage. | How it works | GFX |
| 16 | 2:05 to 2:17 | Matching formula with a worked example (one sided vs mutual). | A match needs both sides. We take the geometric mean of how well each of you fits what the other is looking for, so one sided interest scores low. | reciprocal = √(fit A←B × fit B←A). score = 0.75 × reciprocal + 0.25 × values. Shows when ≥ 0.45 | GFX |
| 17 | 2:17 to 2:23 | Figma canvas of badge, avatars, sound and haptic spec. | Every screen, avatar and sound was designed in Figma first. | Designed in Figma | GFX or SCREEN (Figma file scroll) |
| 18 | 2:23 to 2:32 | End card: app icon, title, tracks, team. | Human Human Interaction Lab. Fewer gambles, better hellos. | Stop gambling on small talk. Ethan Pan, Paul Jiang, Jiayi Tang, Kenny Nguyen | GFX |

Voiceover is about 330 words, a calm pace of roughly 2.3 words per second. Record it in one take per section with a phone in a quiet room (a closet works), 15 cm from the mouth.

### Track callouts (kept short, they sit in the end card)
* Anthropic, Claude for Public Benefit: Claude scores every pair both ways and writes the recap.
* Meta, Bringing People Closer Together: the whole point, fewer wasted hellos.
* Convex: real time match state, badge state, heads ups and recaps.
* Figma, Best Figma Workflow Hack: badge, avatars and sound spec designed in Figma.
* Spacetime: SpacetimeDB as a second backend for live proximity state.

---

## Tonight's filming checklist

Shoot everything in 4K 30 fps (or 1080p 30), horizontal unless noted. Badges at full brightness, Do Not Disturb on, demo accounts signed in.

* [ ] **Shot A, crowd time lapse (0:08)**: phone on a tripod or taped to a railing above the hall, iOS Time Lapse mode, at least 10 minutes. Also grab 2 or 3 handheld walking shots through the tables.
* [ ] **Shot B, lanyard holder (0:39)**: macro close up of the phone sliding into the 3D printed holder, then someone putting the lanyard on. Plain background, side light.
* [ ] **Shot C, hero walk (1:10)**: two teammates with live badges start about 10 m apart and walk toward each other. Camera at chest height behind one person, then reverse angle. Do 3 takes. Then a close up insert on one badge while the other person walks in, so the tint is visible.
* [ ] **Shot D, avatars meet (1:24)**: the two stop and start talking; tight shot on both badges side by side as the avatars hop over. Hold 5 seconds.
* [ ] **Shot E, heartbeat and haptics**: close up with audio of the phone on the lanyard as the match approaches (record sound clean, or capture screen audio).
* [ ] **Screen recordings (iPhone Control Center, Record with mic off)**: (1) texting the Photon agent from scratch to onboard, (2) the heads up text arriving, (3) the recap and follow up after a conversation, (4) People tab and a person's timeline.
* [ ] **Figma**: 10 second smooth scroll of the design file (Screen Studio or QuickTime).
* [ ] **Voiceover**: record the lines above, one file per section.
* [ ] **Team**: 3 second shot of the four of you wearing badges, for the end card (optional).

## Tools (one line each)

* 3D phone mockup: Rotato (drop the screen recording in, animate a tilt, export 4K), or keep the animatic opening.
* Screen recordings with smooth zooms: Screen Studio (Mac), or iOS built in recording plus CapCut keyframe zoom.
* Fast final edit: CapCut desktop (auto captions, easy), or Final Cut Pro if someone already knows it.
* Upload: YouTube, visibility Unlisted, then paste the link in Devpost.
