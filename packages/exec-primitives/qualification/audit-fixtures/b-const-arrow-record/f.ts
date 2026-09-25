const REGISTRY: Record<string, (a: number) => void> = {};
export function registryKeys(): string[] {
  return Object.keys(REGISTRY);
}
