const SCRATCH = new Uint8Array(8);

export function stash(index: number, value: number): number {
  SCRATCH[index] = value;
  return SCRATCH.length;
}
