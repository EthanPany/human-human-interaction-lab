import { TimeDuration } from "spacetimedb";
import type { HttpClient } from "./httpClient";

/**
 * Minimal Claude client for SpacetimeDB procedures (port of convex/lib/claude.ts).
 * `ctx.http.fetch` is synchronous, so everything here is too.
 * Key: ANTHROPIC_API_KEY in the database environment (see README).
 */

export type ClaudeEnv = { ANTHROPIC_API_KEY?: string; CLAUDE_MODEL?: string };

type Block = { type: string; text?: string; input?: unknown };

export function claudeModel(env: ClaudeEnv) {
  return env.CLAUDE_MODEL || "claude-sonnet-5-5";
}

export function callClaude(http: HttpClient, env: ClaudeEnv, body: Record<string, unknown>): Block[] {
  const res = http.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: claudeModel(env), ...body }),
    timeout: TimeDuration.fromMillis(120_000),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${res.text()}`);
  return (res.json() as { content: Block[] }).content;
}

/** Ask for JSON matching `schema` (structured outputs, always valid JSON). */
export function askClaudeJSON<T>(
  http: HttpClient,
  env: ClaudeEnv,
  system: string,
  user: string,
  schema: Record<string, unknown>,
  maxTokens = 2000,
): T {
  const content = callClaude(http, env, {
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
