import Anthropic from "@anthropic-ai/sdk";
import type { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { config } from "./config";

/**
 * The agent's reasoning: Claude with a few tools that call the Convex agent API.
 * Short per-phone history is kept in memory (fine for the demo).
 */

const SYSTEM = `You are the text message agent for a networking badge app at Cal Hacks.
You talk to people over iMessage. Keep every reply short and friendly, like a helpful friend texting.

Your jobs:
1. Onboarding at the person's own pace, one question at a time. Learn and save with save_profile:
   name, headline (what they do), 2 to 4 badge tags (short conversation starters: role, who they are, what they know),
   lookingFor (who they want to meet), offers (what they can help with), hobbies, and appearance
   (a short description so others can find them, only if they are comfortable sharing).
   Save each fact as soon as you learn it. Never ask for something already in the profile.
2. When they reply yes to saving a contact (Y, yes, sure), call confirm_contact.
3. When they share how a conversation went, call add_feedback. If they say a kind of match was not useful,
   you may adjust matching with update_matching_notes (one sentence, general, no names).
4. If they ask who to meet, use the top matches in the context.
Never invent people or facts. Don't mention tools or the database.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "save_profile",
    description: "Save profile fields learned from the conversation. Only include fields you learned.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        headline: { type: "string" },
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

type Turn = Anthropic.MessageParam;

export class Brain {
  private claude = new Anthropic({ apiKey: config.anthropicKey });
  private history = new Map<string, Turn[]>();

  constructor(private convex: ConvexClient) {}

  /** Handle one incoming text and return the reply to send. */
  async reply(phone: string, text: string): Promise<string> {
    await this.convex.mutation(api.agent.ensureUser, { phone });
    const ctx = await this.convex.query(api.agent.context, { phone });

    const turns = this.history.get(phone) ?? [];
    turns.push({ role: "user", content: text });

    let answer = "";
    for (let step = 0; step < 5; step++) {
      const res = await this.claude.messages.create({
        model: config.claudeModel,
        max_tokens: 600,
        system: `${SYSTEM}\n\nContext (JSON): ${JSON.stringify(ctx)}`,
        tools: TOOLS,
        messages: turns,
      });
      turns.push({ role: "assistant", content: res.content });

      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      answer = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (calls.length === 0) break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: await this.runTool(phone, call) });
      }
      turns.push({ role: "user", content: results });
    }

    this.history.set(phone, turns.slice(-16));
    return answer || "Got it!";
  }

  private async runTool(phone: string, call: Anthropic.ToolUseBlock): Promise<string> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    try {
      switch (call.name) {
        case "save_profile": {
          const patch: Record<string, unknown> = {};
          for (const k of ["name", "headline", "lookingFor", "offers", "appearance"]) {
            if (typeof input[k] === "string") patch[k] = input[k];
          }
          for (const k of ["tags", "hobbies"]) {
            if (Array.isArray(input[k])) patch[k] = (input[k] as unknown[]).map(String);
          }
          await this.convex.mutation(api.agent.saveProfile, { phone, patch });
          return "saved";
        }
        case "confirm_contact": {
          const name = await this.convex.mutation(api.agent.confirmContact, { phone });
          return name ? `saved contact: ${name}` : "no recent conversation to save";
        }
        case "add_feedback": {
          await this.convex.mutation(api.agent.addFeedback, {
            phone,
            note: String(input.note ?? ""),
            rating: typeof input.rating === "number" ? input.rating : undefined,
            otherName: typeof input.otherName === "string" ? input.otherName : undefined,
          });
          return "feedback saved";
        }
        case "update_matching_notes": {
          await this.convex.mutation(api.agent.updateRubricNotes, { notes: String(input.notes ?? "") });
          return "matching notes updated";
        }
        default:
          return `unknown tool ${call.name}`;
      }
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  }
}
