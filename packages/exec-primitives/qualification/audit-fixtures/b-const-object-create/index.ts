const TABLE = Object.create(null) as Record<string, number>;

export function remember(key: string, value: number): number {
  TABLE[key] = value;
  return Object.keys(TABLE).length;
}
