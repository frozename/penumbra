export interface RankedResult<T> {
  /**
   * Stable identifier used for deduplication across lists.
   *
   * Examples: t0 event_id, t1 rollup_id, t2 memory_id.
   */
  id: string;
  /**
   * Source-specific score in [0, 1].
   *
   * Note: `fuseRRF` does not use this value for ranking; only the item order in
   * each input list determines rank. The score is preserved from the first
   * occurrence for caller-side provenance.
   */
  score: number;
  /**
   * Opaque per-source payload.
   */
  payload: T;
}

export interface RrfFuseOptions {
  /**
   * RRF constant. Defaults to 60 per the original RRF paper.
   */
  k?: number;
  /**
   * Cap the final fused results to top-N. Undefined means no cap.
   *
   * If `limit <= 0`, `fuseRRF` returns an empty array.
   */
  limit?: number;
}

const DEFAULT_K = 60;

function normalizeK(k: number | undefined): number {
  if (k === undefined || !Number.isFinite(k) || k <= 0) return DEFAULT_K;
  return k;
}

type RrfAccum<T> = RankedResult<T> & {
  fusedScore: number;
  sources: number[];
  firstListIndex: number;
  firstRank: number;
};

function processList<T>(
  list: readonly RankedResult<T>[],
  listIndex: number,
  k: number,
  byId: Map<string, RrfAccum<T>>,
): void {
  const seenInList = new Set<string>();
  let rank = 0;
  for (const item of list) {
    const id = item.id;
    if (id.length === 0 || seenInList.has(id)) continue;
    seenInList.add(id);

    rank += 1;
    const add = 1 / (k + rank);

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        id,
        score: item.score,
        payload: item.payload,
        fusedScore: add,
        sources: [listIndex],
        firstListIndex: listIndex,
        firstRank: rank,
      });
      continue;
    }

    existing.fusedScore += add;
    if (existing.sources[existing.sources.length - 1] !== listIndex) {
      // `lists` are processed in increasing listIndex, so this preserves
      // sorted unique source indices without extra sorting.
      existing.sources = [...existing.sources, listIndex];
    }
  }
}

/**
 * Reciprocal Rank Fusion across N independent ranked lists.
 *
 * IMPORTANT: Input ordering defines rank. The caller is responsible for sorting
 * each list by its own relevance score before passing it to `fuseRRF`.
 *
 * For each input list, items get a per-list rank (1 = best). Final score per
 * unique id = sum_over_lists( 1 / (k + rank_in_list) ). Items present in
 * multiple lists score additively higher.
 *
 * The fused list is sorted by descending fused score and capped at `limit`.
 * `payload` (and `score`) of the first occurrence wins on dedup (caller can
 * preserve list provenance via the input list ordering).
 */
export function fuseRRF<T>(
  lists: readonly (readonly RankedResult<T>[])[],
  opts?: RrfFuseOptions,
): (RankedResult<T> & { fusedScore: number; sources: number[] })[] {
  if (lists.length === 0) return [];

  const limit = opts?.limit;
  if (limit !== undefined && limit <= 0) return [];

  const k = normalizeK(opts?.k);

  const byId = new Map<string, RrfAccum<T>>();

  for (const [listIndex, list] of lists.entries()) {
    processList(list, listIndex, k, byId);
  }

  const fused = Array.from(byId.values());

  // Deterministic ordering:
  // - Desc by fusedScore
  // - For ties, preserve insertion order from the first list that contained the id
  fused.sort((a, b) => {
    if (a.fusedScore !== b.fusedScore) return b.fusedScore - a.fusedScore;
    if (a.firstListIndex !== b.firstListIndex) return a.firstListIndex - b.firstListIndex;
    if (a.firstRank !== b.firstRank) return a.firstRank - b.firstRank;
    return a.id.localeCompare(b.id);
  });

  const capped = limit === undefined ? fused : fused.slice(0, limit);
  return capped.map(({ firstListIndex: _a, firstRank: _b, ...rest }) => rest);
}
