export type ClassifierDeclineMeta = {
  classifier_declined: true;
  decline_reason: "provider_safety_refusal";
};

const PROVIDER_SAFETY_REFUSAL_PATTERNS = [
  /\b(?:i['’]?m|i am)\s+sorry,?\s+but\s+i\s+can(?:not|['’]?t)\s+(?:assist|help)\s+with\s+(?:that|this)\s+request\b/i,
  /\bi\s+can(?:not|['’]?t)\s+(?:assist|help)\s+with\s+(?:that|this)\s+request\b/i,
  /\b(?:i['’]?m|i am)\s+unable\s+to\s+(?:assist|help)\s+with\s+(?:that|this)\s+request\b/i,
  /\bi\s+can(?:not|['’]?t)\s+comply\s+with\s+(?:that|this)\s+request\b/i,
] as const;

export function detectClassifierDecline(input: {
  finalText: string | null | undefined;
  errorText: string | null | undefined;
}): ClassifierDeclineMeta | null {
  const finalText = input.finalText ?? "";
  const errorText = input.errorText ?? "";
  const failedOrEmptyOutput = errorText.trim().length > 0 || finalText.trim().length === 0;
  if (!failedOrEmptyOutput) return null;

  const text = errorText.trim().length > 0 ? errorText : finalText;
  if (!PROVIDER_SAFETY_REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return { classifier_declined: true, decline_reason: "provider_safety_refusal" };
}

export function classifierDeclineMetaFromUnknown(value: unknown): ClassifierDeclineMeta | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.classifier_declined !== true) return null;
  return {
    classifier_declined: true,
    decline_reason: "provider_safety_refusal",
  };
}
