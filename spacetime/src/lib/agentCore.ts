import { TimeDuration } from "spacetimedb";
import type { HttpClient } from "./httpClient";

/**
 * The text agent's brain: a synchronous port of backend/convex/lib/agentCore.ts
 * for SpacetimeDB procedures (`ctx.http.fetch` is synchronous). Prompt and
 * tools are identical; keep them in sync with the Convex copy.
 */

export const AGENT_SYSTEM = `You are the text message agent for a networking badge app at Cal Hacks.
You talk to people over iMessage. Keep every reply short and friendly, like a helpful friend texting.
Write plain text only: no markdown, no asterisks, no headings, no bullet symbols (iMessage shows them literally).

Your jobs:
1. Onboarding at the person's own pace, one question at a time. Learn and save with save_profile:
   name, headline (their role or title), company, location (city), 2 to 4 badge tags (short conversation starters: role, who they are, what they know),
   lookingFor (who they want to meet), offers (what they can help with), hobbies, and appearance
   (a short description so others can find them, only if they are comfortable sharing).
   Save each fact as soon as you learn it. Never ask for something already in the profile.
2. When they reply yes to saving a contact (Y, yes, sure), call confirm_contact.
3. When they share how a conversation went, call add_feedback. If they say a kind of match was not useful,
   you may adjust matching with update_matching_notes (one sentence, general, no names).
4. If they ask who to meet, use the top matches in the context.
Never invent people or facts. Don't mention tools or the database.`;

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

/** What the brain needs from its host: the agent API (api/agent.ts, each call its own transaction). */
export type AgentHost = {
  context(phone: string): unknown;
  ensureUser(phone: string): unknown;
  saveProfile(phone: string, patch: Record<string, unknown>): unknown;
  confirmContact(phone: string): string | null;
  addFeedback(phone: string, note: string, rating?: number, otherName?: string): unknown;
  updateRubricNotes(notes: string): unknown;
};

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
export function agentReply(opts: {
  http: HttpClient;
  host: AgentHost;
  apiKey: string;
  model: string;
  phone: string;
  text: string;
  history: Turn[];
}): { reply: string; history: Turn[] } {
  const { host, phone } = opts;
  host.ensureUser(phone);
  const context = host.context(phone);
  const turns: Turn[] = [...opts.history, { role: "user", content: opts.text }];

  let answer = "";
  for (let step = 0; step < 5; step++) {
    const res = opts.http.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 600,
        system: `${AGENT_SYSTEM}\n\nContext (JSON): ${JSON.stringify(context)}`,
        tools: AGENT_TOOLS,
        messages: turns,
      }),
      timeout: TimeDuration.fromMillis(60_000),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${res.text()}`);
    const content = (res.json() as { content: Block[] }).content.filter(
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
      results.push({ type: "tool_result", tool_use_id: call.id, content: runTool(host, phone, call.name, call.input) });
    }
    turns.push({ role: "user", content: results });
  }
  return { reply: answer || "Got it!", history: trimHistory(turns, 16) };
}

function runTool(host: AgentHost, phone: string, name: string, input: Record<string, unknown>): string {
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
        host.saveProfile(phone, patch);
        return "saved";
      }
      case "confirm_contact": {
        const saved = host.confirmContact(phone);
        return saved ? `saved contact: ${saved}` : "no recent conversation to save";
      }
      case "add_feedback":
        host.addFeedback(
          phone,
          String(input.note ?? ""),
          typeof input.rating === "number" ? input.rating : undefined,
          typeof input.otherName === "string" ? input.otherName : undefined,
        );
        return "feedback saved";
      case "update_matching_notes":
        host.updateRubricNotes(String(input.notes ?? ""));
        return "matching notes updated";
      default:
        return `unknown tool ${name}`;
    }
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}
