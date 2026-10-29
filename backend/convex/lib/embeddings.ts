/**
 * Optional semantic retrieval with Voyage AI embeddings (1024 dims).
 * Set the key with:  npx convex env set VOYAGE_API_KEY <key>
 * Without a key, matching scores every candidate (fine below a few dozen people).
 */

export const EMBEDDING_DIMS = 1024;

export function embeddingsAvailable(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY);
}

export async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.VOYAGE_API_KEY ?? ""}`,
    },
    body: JSON.stringify({ input: texts, model: process.env.VOYAGE_MODEL ?? "voyage-3.5-lite", input_type: "document" }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

type ProfileText = {
  name?: string;
  headline?: string;
  company?: string;
  tags?: string[];
  lookingFor?: string;
  offers?: string;
  hobbies?: string[];
};

/** What this person is looking for, as one sentence for embedding. */
export function seekText(p: ProfileText): string {
  return `Wants to meet: ${p.lookingFor ?? "anyone interesting"}.`;
}

/** Who this person is and what they bring, as one sentence for embedding. */
export function aboutText(p: ProfileText): string {
  return [
    p.headline && `${p.headline}${p.company ? ` at ${p.company}` : ""}.`,
    p.tags?.length && `Known for: ${p.tags.join(", ")}.`,
    p.offers && `Can help with: ${p.offers}.`,
    p.hobbies?.length && `Hobbies: ${p.hobbies.join(", ")}.`,
  ]
    .filter(Boolean)
    .join(" ");
}
