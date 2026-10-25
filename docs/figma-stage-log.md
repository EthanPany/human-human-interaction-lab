# Figma stage log

Human Human Interaction Lab, Cal Hacks 13.0. Track: Best Figma Workflow Hack.

Team: Ethan Pan (UC Berkeley and UW Madison), Paul Jiang (UC Irvine), Jiayi Tang (UC Berkeley), Kenny Nguyen (SFU).

Design file: https://www.figma.com/design/fT0XfUlJq0W47Z33XfjnYY
Slides deck: https://www.figma.com/slides/BmPqBLJ5MtsRGWvCoXdBGR
Repos: https://github.com/EthanPany/human-human-interaction-lab and https://github.com/EthanPany/human-human-interaction-lab-ios

The hack in one line: one Figma file is the shared brain of a four person team and a coding agent. Designers draw, the agent reads the frames into SwiftUI through the Figma MCP server, and then writes the poster, the video storyboard and the submission checklist back into the same file.

## Stage 1. Ideation and wireframes

**Product: Figma Design (page "Story telling")**

We started by drawing the product before writing code. The section "App wireframe (MVP)" holds 14 grayscale screens that cover the whole flow: sign up with a phone number, setup choice, the Badge tab window, the worn badge (default, matched tag in front, horizontal), California mode record prompt, modular Profile, Settings, People list and detail, the agent's text thread, a two column landscape Profile and an iPad split view. A yellow "Design notes for designers" card next to them explains the rules (the app is for display, messages are for interaction; proximity shows as glow and color, never meters).

A second section, "iPhone Duo interaction", walks through five states (open, closing, closed and worn, pinch in, open again) with a shared state model, a Normal iPhone vs iPhone Duo table and build notes.

Why Figma Design: frames at real device sizes let us argue about layout and flow in minutes, and the same frames later became the spec the coding agent read. Sticky style notes live on the canvas next to the screens they describe, so nobody has to find a separate doc.

## Stage 2. Brand, avatars and the designer's UI

**Product: Figma Design (designer pages)**

Our designer turned the gray wireframes into a visual language. The "Profile final (scroll)" frames set the look: a cream background (#FEF3D4), bold black names, rounded colored cards in red, yellow, purple, green and blue, puzzle piece and blob characters with eyes, and cream icon buttons with soft shadows. A "Frame 3" sheet explores a family of blob shapes, with a note to include more blob types. The design notes on that page describe the badge content changing with the other person's interests.

On the Submission page the designer drew the "Mutual" art: two gradient faces overlapping on black with a grain texture, and a mascot frame of two blobs meeting.

Why Figma Design: vector networks, gradients and noise texture let the designer iterate on characters fast, and everything stays editable for the engineers to inspect. Keeping the brand in the same file as the wireframes meant the agent could compare the two directly.

## Stage 3. Design to code with the Figma MCP server

**Product: Figma MCP server (Dev Mode context: get_design_context, get_screenshot, get_metadata)**

Instead of a handoff, our coding agent (Claude) read the frames directly. It pulled the designer's Profile final page through the Figma MCP server and turned it into a SwiftUI design system. `HHIL/DesignSystem/Theme.swift` in the iOS repo opens with "Values follow the designer's Figma page (Profile final)" and uses the same cream #FEF3D4 and palette. The commit "Designer look: living avatars, flowing background, new badge with photo layouts, moments, avatar editor" (e8c5f41, Oct 24) touched 43 files, adding the avatar engine, IdentityCard, InterestsCard and the new badge style. The blob sketches became a living avatar whose shapes morph between each other.

The app icon came the same way: commit 6fe3156, "App icon: the designer's gradient face from Figma (Submission page, Frame 1)".

Why the MCP server: the agent reads exact colors, sizes and layer structure plus a screenshot of the frame, so a design change reaches the phone within one build, with no redlines and no lost details.

## Stage 4. Code back to Figma

**Product: Figma MCP server (use_figma, writing with the Plugin API) into Figma Design**

The loop also runs the other way. The agent wrote our project artifacts into the Submission page so the whole team could review and edit them on the canvas:

* "Poster 48x36 (academic)": problem, our thinking, related work and solution columns in the app's palette, using the designer's Mutual art. Exported to `poster/poster.png` and `poster/poster.pdf` (commit 143cca0).
* "Demo video (3 min max)": an 18 row storyboard that mirrors `video/script.md`, and "Demo video sketches": one sketch per row, with red FILM tags for live shots.
* "Devpost draft", "Presentation and judging" and "Checklist and links", kept in sync with the repo status overnight.

Why: teammates who never open the repo still see the latest plan, can comment, and can fix a word on the poster themselves. Figma stays the single source of truth for both design and project state.

## Stage 5. Submission and pitch

**Product: Figma Slides**

This deck, "Human Human Interaction Lab, Figma workflow", was built in Figma Slides, also by the agent through the MCP server. It reuses frames exported from the design file (wireframes, Duo flow, designer UI, poster, storyboard) and links back to each frame in the design file and to both repos. The demo video has a "Designed in Figma" beat showing the canvas.

Deck: https://www.figma.com/slides/BmPqBLJ5MtsRGWvCoXdBGR

Why Figma Slides: the pitch lives next to the work it describes, uses the same palette and type as the poster, and judges can jump from any slide into the real frames.
