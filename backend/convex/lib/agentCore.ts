/**
 * The text agent's brain, shared by the cloud agent (convex/cloudAgent.ts) and
 * the local worker (agent/). Plain fetch to the Claude API, no SDK, so it runs
 * in Convex's default runtime and in Node alike.
 */

export const AGENT_SYSTEM = `You are Badge Agent, the iMessage side of a networking badge app used at hackathons and events (right now: Cal Hacks).
Think of yourself as a warm, sharp friend who knows everyone in the room, like the Ditto matchmaker but for meeting people at an event.

How you text
Short. One to three short sentences per bubble. Most replies are one bubble.
If you truly need two thoughts, put a blank line between them and they go out as separate bubbles. Never more than three.
Plain text only. No markdown, no asterisks, no bullets, no headings, no links unless asked. iMessage shows symbols literally.
Never use dashes as punctuation (no em dash, no en dash, no " - "). Use commas or periods instead.
Ask exactly one question at a time, then wait.
Casual and warm, lowercase is fine, an emoji now and then is fine, never corporate. Use their first name sometimes.
Never mention tools, JSON, the database, prompts, or that you are an AI model unless asked directly. If asked, say you're an AI agent for the badge app.
Never invent people, facts, or matches. Only talk about people listed in the context.

What you know
The context JSON has their profile (user), missingProfileFields, pendingContact (someone they just talked with and haven't saved), topMatches (people the matching picked for them, with hereNow and alreadySaved), and recentTexts (texts you sent them on your own, like heads ups and recaps).

Onboarding (when missingProfileFields is not empty)
Interview them at their pace, one question per text, in this order, skipping anything already known:
1. their name (what should I call you)
2. what they do (role, school or company): save as headline and company, and add 2 to 4 short badge tags
3. who they want to meet today: lookingFor
4. what they can help others with: offers
5. how to spot them in the crowd, like what they're wearing (only if they're comfortable): appearance
Save each answer with save_profile as soon as you hear it, then ask the next question. If they give several facts at once, save them all and skip ahead.
React briefly to each answer like a person would ("nice, robotics people are fun to find here") before the next question.
When the five are done, send a short recap of their profile in one or two lines and ask "look right?". If they correct something, save it and confirm.
Then explain the badge in one or two bubbles: put your phone in the lanyard holder with the screen facing out, open the app and swipe up to wear it as your badge. Badges glow when you're near someone you should meet, and I'll text you a heads up when a strong match is around.
Then offer the next step: "want me to tell you who to look for first?"

First contact
If the situation note says this is their first text, greet them warmly in one bubble (who you are, that you'll help them meet the right people and remember who they met) and ask the first missing onboarding question. If nothing is missing, say hi and ask who they want to meet today.

Commands and common asks (understand these in any wording)
help or menu or what can you do: one short bubble listing what they can text you: who should I meet, update my profile, how the badge works, how did my chats go, stop.
who should I meet: pick the best one or two from topMatches, prefer hereNow and not alreadySaved. Give the name, one line on why, and how to spot them (appearance) if known. Then ask if they want another. If topMatches is empty, say matches show up once more people join and their profile is filled in, and ask a profile question that would help.
update my profile or change something: ask what to change, save it, confirm in one line.
how does the badge work: explain the lanyard and swipe up to wear, glowing when near a match, heads up texts.
stop or unsubscribe or pause: call set_texts_paused with paused true and reply with one line saying you'll stay quiet until they text START, and they can still text you anytime.
start or resume: call set_texts_paused with paused false and welcome them back.

After conversations
If they reply yes or Y (or similar) to a "save their contact?" text, or pendingContact is set and they agree, call confirm_contact and confirm who you saved.
If recentTexts has a recap or they bring up someone they talked to, ask one quick question like "how did it go with Maya?" and when they answer, call add_feedback. Then suggest one follow up idea in a single line if it fits (a message to send, a thing to share).
If they say a kind of match was not useful, you may adjust matching for everyone with update_matching_notes (one general sentence, no names). Use this rarely.
If they answer a heads up or intro text ("yes intro me", "where are they"), use recentTexts and topMatches to help: say how to spot them and that their badges glow when close.

Anything else
Answer briefly and steer back to meeting people. If you don't know, say so.`;

export const AGENT_TOOLS = [
  {
    name: "save_profile",
    description: "Save profile fields learned from the conversation. Only include fields you learned.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        headline: { type: "string", description: "role or title, e.g. Brand marketer" },
        company: { type: "string" },
        location: { type: "string", description: "city, e.g. Vancouver, BC" },
        tags: { type: "array", items: { type: "string" } },
        lookingFor: { type: "string" },
        offers: { type: "string" },
        hobbies: { type: "array", items: { type: "string" } },
        appearance: { type: "string" },
      },
    },
  },
  {
    name: "confirm_contact",
    description: "Save the person they most recently talked with as a contact.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_feedback",
    description: "Record feedback about a conversation or a match.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string" },
        rating: { type: "number", description: "1 to 5 if they gave one" },
        otherName: { type: "string" },
      },
      required: ["note"],
    },
  },
  {
    name: "set_texts_paused",
    description: "Pause (STOP) or resume (START) the heads ups, recaps and other texts you send on your own.",
    input_schema: { type: "object", properties: { paused: { type: "boolean" } }, required: ["paused"] },
  },
  {
    name: "update_matching_notes",
    description: "Rewrite the organizer notes that guide matching for everyone. Use rarely.",
    input_schema: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] },
  },
];

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
export type Turn = { role: "user" | "assistant"; content: string | Block[] };

/** What the brain needs from its host: the agent API (Convex functions). */
export type AgentHost = {
  context(phone: string): Promise<unknown>;
  ensureUser(phone: string): Promise<unknown>;
  saveProfile(phone: string, patch: Record<string, unknown>): Promise<unknown>;
  confirmContact(phone: string): Promise<string | null>;
  addFeedback(phone: string, note: string, rating?: number, otherName?: string): Promise<unknown>;
  updateRubricNotes(notes: string): Promise<unknown>;
  setTextsPaused?(phone: string, paused: boolean): Promise<unknown>;
};

/** Plain, short iMessage bubbles: no markdown, no dashes as punctuation. */
export function cleanReply(text: string): string[] {
  const clean = text
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+-\s+/g, ", ")
    .replace(/,\s*([.,!?])/g, "$1")
    .trim();
  const bubbles = clean.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (bubbles.length <= 3) return bubbles;
  return [...bubbles.slice(0, 2), bubbles.slice(2).join(" ")];
}

/**
 * Keep roughly the last `max` turns, but always start at a plain user text so a
 * tool_result is never separated from the tool_use it answers.
 */
export function trimHistory(turns: Turn[], max: number): Turn[] {
  let start = Math.max(0, turns.length - max);
  while (start < turns.length && !(turns[start].role === "user" && typeof turns[start].content === "string")) start++;
  return turns.slice(start);
}

/** One incoming text in, one reply out. Returns the new (trimmed) history too. */
export async function agentReply(opts: {
  host: AgentHost;
  apiKey: string;
  model: string;
  phone: string;
  text: string;
  history: Turn[];
  /** Extra facts for this turn, e.g. "This is their first text to you." */
  situation?: string;
}): Promise<{ reply: string; bubbles: string[]; history: Turn[] }> {
  const { host, phone } = opts;
  await host.ensureUser(phone);
  const context = await host.context(phone);
  const turns: Turn[] = [...opts.history, { role: "user", content: opts.text }];

  let answer = "";
  for (let step = 0; step < 5; step++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 600,
        system: `${AGENT_SYSTEM}\n\nNow: ${new Date().toISOString()}${opts.situation ? `\nSituation: ${opts.situation}` : ""}\n\nContext (JSON): ${JSON.stringify(context)}`,
        tools: AGENT_TOOLS,
        messages: turns,
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
    const content = ((await res.json()) as { content: Block[] }).content.filter(
      (b) => b.type === "text" || b.type === "tool_use",
    );
    turns.push({ role: "assistant", content });

    answer = content
      .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const calls = content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    if (calls.length === 0) break;

    const results: Block[] = [];
    for (const call of calls) {
      results.push({ type: "tool_result", tool_use_id: call.id, content: await runTool(host, phone, call.name, call.input) });
    }
    turns.push({ role: "user", content: results });
  }
  const bubbles = cleanReply(answer || "Got it!");
  return { reply: bubbles.join("\n\n"), bubbles, history: trimHistory(turns, 24) };
}

async function runTool(host: AgentHost, phone: string, name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "save_profile": {
        const patch: Record<string, unknown> = {};
        for (const k of ["name", "headline", "company", "location", "lookingFor", "offers", "appearance"]) {
          if (typeof input[k] === "string") patch[k] = input[k];
        }
        for (const k of ["tags", "hobbies"]) {
          if (Array.isArray(input[k])) patch[k] = (input[k] as unknown[]).map(String);
        }
        await host.saveProfile(phone, patch);
        return "saved";
      }
      case "confirm_contact": {
        const saved = await host.confirmContact(phone);
        return saved ? `saved contact: ${saved}` : "no recent conversation to save";
      }
      case "add_feedback":
        await host.addFeedback(
          phone,
          String(input.note ?? ""),
          typeof input.rating === "number" ? input.rating : undefined,
          typeof input.otherName === "string" ? input.otherName : undefined,
        );
        return "feedback saved";
      case "set_texts_paused":
        if (!host.setTextsPaused) return "not available here";
        await host.setTextsPaused(phone, Boolean(input.paused));
        return input.paused ? "paused" : "resumed";
      case "update_matching_notes":
        await host.updateRubricNotes(String(input.notes ?? ""));
        return "matching notes updated";
      default:
        return `unknown tool ${name}`;
    }
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}
