// The generic is return-position-only by design: callers tag the parsed shape
// (e.g. safeParseJSON<Eligibility>(row)) the same way the prior inline
// `JSON.parse(...) as T` casts did, just without throwing on malformed input.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function safeParseJSON<T>(json: string | null | undefined): T | null {
  if (json === null || json === undefined) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
