// Text message agent worker.
// Sends whatever lands in the Convex outbox and replies to incoming texts with Claude.
import { ConvexClient } from "convex/browser";
import Anthropic from "@anthropic-ai/sdk";
import { api } from "../convex/_generated/api";

const convex = new ConvexClient(process.env.CONVEX_URL!);
const claude = new Anthropic(); // reads ANTHROPIC_API_KEY

// TODO(photon): create the Spectrum app with the iMessage provider and
// replace sendText / the inbound handler below. See docs.photon.codes.
async function sendText(phone: string, body: string) {
  console.log(`[to ${phone}] ${body}`);
}

// Outbound: everything the backend wants to say goes through the outbox
convex.onUpdate(api.outbox.pending, {}, async (messages) => {
  for (const m of messages) {
    await sendText(m.phone, m.body);
    await convex.mutation(api.outbox.markSent, { id: m._id });
  }
});

// Inbound: call this from the Spectrum message loop
export async function handleIncoming(phone: string, text: string) {
  const user = await convex.query(api.users.byPhone, { phone });
  const res = await claude.messages.create({
    model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
    max_tokens: 400,
    system:
      "You are a friendly event networking agent that talks over text. " +
      "Keep replies short. Collect name, headline, badge tags, who they want to meet, " +
      "and a short description of what they look like, one question at a time.",
    messages: [
      {
        role: "user",
        content: `Profile so far: ${JSON.stringify(user ?? {})}\n\nThey texted: ${text}`,
      },
    ],
  });
  const reply = res.content.find((b) => b.type === "text")?.text ?? "";
  await sendText(phone, reply);
}

console.log("Agent worker running");
