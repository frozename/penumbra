export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonRecord(raw: string): JsonRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

export function readRecord(source: JsonRecord, key: string): JsonRecord | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

export function readString(source: JsonRecord, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

export function readNumber(source: JsonRecord, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function numberFrom(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
