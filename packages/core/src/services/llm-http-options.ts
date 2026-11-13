function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveInteger(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`invalid generation ${name}`);
  }
  return value;
}

const RESERVED_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "n",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "response_format",
  "temperature",
  "tools",
  "tool_choice",
]);

export function resolveLlmCandidateSelection(value: unknown): "ordered" | "round-robin" {
  if (value === undefined || value === "round-robin") return "round-robin";
  if (value === "ordered") return "ordered";
  throw new Error("invalid generation candidateSelection");
}

export function resolveLlmHttpOptions(
  options: Record<string, unknown> | undefined,
  defaults: { maxTokens: number; timeoutMs: number },
): { requestExtras: Record<string, unknown>; maxTokens: number; timeoutMs: number } {
  const extras = options?.["requestExtras"];
  if (extras !== undefined && !plainObject(extras))
    throw new Error("invalid generation requestExtras");
  return {
    requestExtras: Object.fromEntries(
      Object.entries(extras ?? {}).filter(([key]) => !RESERVED_FIELDS.has(key)),
    ),
    maxTokens: positiveInteger(options?.["maxTokens"] ?? defaults.maxTokens, "maxTokens", 16_384),
    timeoutMs: Math.min(
      defaults.timeoutMs,
      positiveInteger(
        options?.["requestTimeoutMs"] ?? defaults.timeoutMs,
        "requestTimeoutMs",
        900_000,
      ),
    ),
  };
}
