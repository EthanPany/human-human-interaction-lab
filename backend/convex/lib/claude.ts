/**
 * Minimal Claude client for Convex actions (plain fetch, works in the default runtime).
 * Set the key with:  npx convex env set ANTHROPIC_API_KEY <key>
 */

export function claudeAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function askClaude(system: string, user: string, maxTokens = 1500): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  return data.content.find((b) => b.type === "text")?.text ?? "";
}

/** Ask for JSON and parse the first JSON value in the reply. */
export async function askClaudeJSON<T>(system: string, user: string, maxTokens = 2000): Promise<T> {
  const text = await askClaude(system + "\nReply with JSON only, no prose.", user, maxTokens);
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  return JSON.parse(text.slice(start, end + 1)) as T;
}
