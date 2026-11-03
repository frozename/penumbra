import { createHash } from "node:crypto";

export class CanonicalJsonError extends Error {}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(value: object): value is Record<string, unknown> {
  if (Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalidJson(value: unknown): CanonicalJsonError {
  const kind = typeof value;
  return new CanonicalJsonError(`cannot canonically encode value of type ${kind}`);
}

function canonicalNumber(value: number): JsonValue {
  if (!Number.isFinite(value)) throw invalidJson(value);
  return value;
}

function canonicalUndefined(rejectUndefined: boolean): JsonValue {
  if (rejectUndefined) throw invalidJson(undefined);
  return null;
}

function canonicalizeObject(value: object, rejectUndefined: boolean): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, rejectUndefined));
  }
  if (!isPlainObject(value)) throw invalidJson(value);
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).toSorted()) {
    const entryValue = value[key];
    if (entryValue === undefined) {
      if (rejectUndefined) throw invalidJson(value);
      continue;
    }
    out[key] = canonicalize(entryValue, rejectUndefined);
  }
  return out;
}

function canonicalize(value: unknown, rejectUndefined: boolean): JsonValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return canonicalNumber(value);
    case "undefined":
      return canonicalUndefined(rejectUndefined);
    case "object":
      return value === null ? null : canonicalizeObject(value, rejectUndefined);
    case "bigint":
    case "symbol":
    case "function":
      throw invalidJson(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, true));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripOmitted(value: unknown, omit: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripOmitted(item, omit));
  }
  if (typeof value === "object" && value !== null && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (omit.has(key)) continue;
      out[key] = stripOmitted(value[key], omit);
    }
    return out;
  }
  return value;
}

export function digestOf(value: unknown, opts: { omit?: readonly string[] } = {}): string {
  const omit = new Set(opts.omit ?? []);
  return sha256Hex(canonicalJson(stripOmitted(value, omit)));
}

export function recipeHash(recipe: unknown): string {
  return digestOf(recipe, { omit: ["recipe_id", "notes", "created_at"] });
}

export function taskDigest(text: string): string {
  const normalized = text.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return sha256Hex(lines.join("\n"));
}

export function handoffRefDigest(handoffId: string): string {
  return sha256Hex(`handoff:${handoffId}`);
}
