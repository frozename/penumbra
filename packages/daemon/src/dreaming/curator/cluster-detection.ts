import type { Database } from "bun:sqlite";

export function findSimilarityClusters(
  db: Database,
  opts: { minSize: number; minWeight: number },
): string[][] {
  const edges = db
    .prepare(
      `
    SELECT src_id, dst_id 
    FROM memory_links 
    WHERE link_type='semantic_near' AND retired_at IS NULL AND weight >= ?
  `,
    )
    .all(opts.minWeight) as { src_id: string; dst_id: string }[];

  const parent = new Map<string, string>();

  function find(i: string): string {
    if (!parent.has(i)) {
      parent.set(i, i);
      return i;
    }
    const parentVal = parent.get(i);
    if (parentVal === i || parentVal === undefined) return i;
    const root = find(parentVal);
    parent.set(i, root);
    return root;
  }

  function union(i: string, j: string): void {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) {
      if (rootI < rootJ) {
        parent.set(rootJ, rootI);
      } else {
        parent.set(rootI, rootJ);
      }
    }
  }

  for (const edge of edges) {
    union(edge.src_id, edge.dst_id);
  }

  const clusters = new Map<string, string[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    if (!clusters.has(root)) {
      clusters.set(root, []);
    }
    const clusterArr = clusters.get(root);
    if (clusterArr !== undefined) clusterArr.push(key);
  }

  return Array.from(clusters.values())
    .filter((cluster) => cluster.length >= opts.minSize)
    .map((cluster) => cluster.sort());
}
