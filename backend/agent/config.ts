// Bun loads backend/.env.local automatically.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env.local and fill it in.`);
  return value;
}

export const config = {
  convexUrl: process.env.CONVEX_URL ?? required("CONVEX_URL"),
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
  /** "photon" sends real iMessages; "console" lets you chat in the terminal. */
  transport: (process.env.AGENT_TRANSPORT ?? "photon") as "photon" | "console",
  photonProjectId: process.env.PHOTON_PROJECT_ID,
  photonProjectSecret: process.env.PHOTON_PROJECT_SECRET,
};
