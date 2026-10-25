// npm run agent loads backend/.env.local (tsx --env-file).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env.local and fill it in.`);
  return value;
}

export const config = {
  convexUrl: process.env.CONVEX_URL ?? required("CONVEX_URL"),
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
  /**
   * "photon2": Photon 2.0 (app.beta.photon.codes), project id + API key.
   * "photon":  legacy Photon Spectrum (app.photon.codes), project id + secret.
   * "console": chat with the agent in the terminal.
   * Defaults to photon when SPECTRUM_PROJECT_SECRET is set, else photon2.
   */
  transport: (process.env.AGENT_TRANSPORT ||
    (process.env.SPECTRUM_PROJECT_SECRET ? "photon" : process.env.PHOTON_API_KEY ? "photon2" : "photon")) as
    | "photon2"
    | "photon"
    | "console",
  photonProjectId: process.env.PHOTON_PROJECT_ID,
  /** Photon Spectrum (app.photon.codes) project, a dedicated line that can text first. */
  spectrumProjectId: process.env.SPECTRUM_PROJECT_ID ?? process.env.PHOTON_PROJECT_ID,
  photonApiKey: process.env.PHOTON_API_KEY,
  photonProjectSecret: process.env.SPECTRUM_PROJECT_SECRET ?? process.env.PHOTON_PROJECT_SECRET,
};
