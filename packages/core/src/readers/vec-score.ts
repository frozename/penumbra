// sqlite-vec reports L2 distance on unit-normalized vectors in [0, 2].
export function toScore(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance / 2));
}
