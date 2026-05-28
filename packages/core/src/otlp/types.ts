export type OtlpAttrValue =
  | { stringValue: string }
  | { intValue: number | string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpAttrValue[] } }
  | Record<string, never>; // empty {} when value is unset

export interface OtlpAttribute {
  key: string;
  value: OtlpAttrValue;
}

export interface OtlpResource {
  attributes: OtlpAttribute[];
  droppedAttributesCount?: number;
}

export interface OtlpLogRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  body?: { stringValue?: string };
  attributes: OtlpAttribute[];
  droppedAttributesCount?: number;
}

export interface OtlpScopeLogs {
  scope: { name?: string; version?: string };
  logRecords: OtlpLogRecord[];
}

export interface OtlpResourceLogs {
  resource: OtlpResource;
  scopeLogs: OtlpScopeLogs[];
}

export interface OtlpLogsEnvelope {
  resourceLogs: OtlpResourceLogs[];
}

export interface ParsedLogRecord {
  timeUnixNano: string | null;
  resourceAttrs: Record<string, unknown>;
  scopeName: string | null;
  body: string | null;
  attrs: Record<string, unknown>;
}

export function attrToValue(v: OtlpAttrValue): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) return v.arrayValue.values.map(attrToValue);
  return null;
}

export function attrsToObject(attrs: OtlpAttribute[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs) out[a.key] = attrToValue(a.value);
  return out;
}
