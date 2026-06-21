export interface NearDuplicateItem {
  body: string;
  embedding: Float32Array;
  why?: string | null;
  depth?: number | null;
}

export interface NearDuplicateMatch<TExisting extends NearDuplicateItem> {
  existing: TExisting;
  similarity: number;
  winner: "existing" | "candidate";
}

export function isNearDuplicate<TExisting extends NearDuplicateItem>(
  candidate: NearDuplicateItem,
  existingEmbeddings: TExisting[],
  threshold: number,
): NearDuplicateMatch<TExisting> | null {
  let best: { existing: TExisting; similarity: number } | null = null;

  for (const existing of existingEmbeddings) {
    const sim = cosineSim(candidate.embedding, existing.embedding);
    if (sim > threshold && (!best || sim > best.similarity)) {
      best = { existing, similarity: sim };
    }
  }

  if (!best) return null;

  const candidateScore = scoreMemoryQuality(candidate);
  const existingScore = scoreMemoryQuality(best.existing);

  return {
    existing: best.existing,
    similarity: best.similarity,
    winner: candidateScore > existingScore ? "candidate" : "existing",
  };
}

export function scoreMemoryQuality(
  item: Pick<NearDuplicateItem, "body" | "why" | "depth">,
): number {
  const densityScore = Math.min(3, compactLength(item.body) / 80);
  const whyScore = item.why && item.why.trim().length > 0 ? 1 : 0;
  const depth = item.depth ?? 0;
  const depthScore = Math.min(2, Math.max(0, depth) / 2);
  return densityScore + whyScore + depthScore;
}

function compactLength(text: string): number {
  return text.replaceAll(/\s+/g, " ").trim().length;
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `near-dup cosineSim dimension mismatch: candidate=${String(a.length)} existing=${String(b.length)}`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
