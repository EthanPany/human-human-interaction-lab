/**
 * Minimal Claude client for Convex actions (plain fetch, works in the default runtime).
 * Set the key with:  npx convex env set ANTHROPIC_API_KEY <key>
 */

export function claudeAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

type Block = { type: string; text?: string; input?: unknown };

async function callClaude(body: Record<string, unknown>): Promise<Block[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5", ...body }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: Block[] };
  return data.content;
}

export async function askClaude(system: string, user: string, maxTokens = 1500): Promise<string> {
  const content = await callClaude({
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return content.find((b) => b.type === "text")?.text ?? "";
}

/**
 * Ask for JSON matching `schema` (JSON Schema, top level object, every object
 * with additionalProperties: false). Uses structured outputs, so the reply is
 * always valid JSON that fits the schema.
 */
export async function askClaudeJSON<T>(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  maxTokens = 2000,
): Promise<T> {
  const content = await callClaude({
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema } },
  });
  const text = content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Claude returned no JSON");
  return JSON.parse(text) as T;
}

/** Small helper: an object schema where every listed property is required. */
export function objectSchema(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
