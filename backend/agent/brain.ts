import type { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { agentReply, type AgentHost, type Turn } from "../convex/lib/agentCore";
import { config } from "./config";

/**
 * Local worker brain: the shared agent core (convex/lib/agentCore.ts) wired to
 * Convex over the client. History lives in memory (fine for local testing).
 */
export class Brain {
  private history = new Map<string, Turn[]>();
  /** One message at a time per phone, so tool calls never interleave. */
  private queues = new Map<string, Promise<unknown>>();
  private host: AgentHost;

  constructor(private convex: ConvexClient) {
    this.host = {
      context: (phone) => convex.query(api.agent.context, { phone }),
      ensureUser: (phone) => convex.mutation(api.agent.ensureUser, { phone }),
      saveProfile: (phone, patch) => convex.mutation(api.agent.saveProfile, { phone, patch }),
      confirmContact: (phone) => convex.mutation(api.agent.confirmContact, { phone }),
      addFeedback: (phone, note, rating, otherName) =>
        convex.mutation(api.agent.addFeedback, { phone, note, rating, otherName }),
      updateRubricNotes: (notes) => convex.mutation(api.agent.updateRubricNotes, { notes }),
      setTextsPaused: (phone, paused) => convex.mutation(api.agent.setTextsPaused, { phone, paused }),
    };
  }

  /** Handle one incoming text and return the reply to send. */
  reply(phone: string, text: string): Promise<string> {
    const previous = this.queues.get(phone) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.replyNow(phone, text));
    this.queues.set(phone, next);
    return next;
  }

  private async replyNow(phone: string, text: string): Promise<string> {
    if (!config.anthropicKey) throw new Error("ANTHROPIC_API_KEY missing in .env.local");
    const { reply, history } = await agentReply({
      host: this.host,
      apiKey: config.anthropicKey,
      model: config.claudeModel,
      phone,
      text,
      history: this.history.get(phone) ?? [],
    });
    this.history.set(phone, history);
    return reply;
  }
}
