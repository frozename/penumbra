import type { OtlpLogsEnvelope, ParsedLogRecord } from "./types.js";

import { attrsToObject } from "./types.js";

export function parseOtlpLogs(envelope: unknown): ParsedLogRecord[] {
  const env = envelope as Partial<OtlpLogsEnvelope> | null | undefined;
  if (!env || !Array.isArray(env.resourceLogs)) return [];
  const out: ParsedLogRecord[] = [];
  for (const rl of env.resourceLogs) {
    const resourceAttrs = attrsToObject(rl.resource.attributes);
    for (const sl of rl.scopeLogs) {
      const scopeName = sl.scope.name ?? null;
      for (const lr of sl.logRecords) {
        out.push({
          timeUnixNano: lr.timeUnixNano ?? null,
          resourceAttrs,
          scopeName,
          body: lr.body?.stringValue ?? null,
          attrs: attrsToObject(lr.attributes),
        });
      }
    }
  }
  return out;
}
