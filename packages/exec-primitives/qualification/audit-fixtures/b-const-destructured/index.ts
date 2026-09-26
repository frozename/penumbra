const { probeRegistry } = { probeRegistry: new Map<string, number>() };

export function probe(key: string): number {
  const next = (probeRegistry.get(key) ?? 0) + 1;
  probeRegistry.set(key, next);
  return next;
}
