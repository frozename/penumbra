function identity<T>(value: T): T {
  return value;
}

const REGISTRY = identity(new Map<string, number>());

export function register(key: string): number {
  REGISTRY.set(key, REGISTRY.size);
  return REGISTRY.size;
}
