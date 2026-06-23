type Extractor = (args: unknown) => string;

const extractors = new Map<string, Extractor>();

function getArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  return undefined;
}

export function registerTargetExtractor(tool: string, fn: Extractor): void {
  extractors.set(tool, fn);
}

registerTargetExtractor("ha:automation.set", (a) => getArg(a, "entity_id") ?? "");
registerTargetExtractor("ha:automation.delete", (a) => getArg(a, "entity_id") ?? "");
registerTargetExtractor("ha:automation.get", (a) => getArg(a, "entity_id") ?? "");
registerTargetExtractor("ha:integration.install", (a) => getArg(a, "domain") ?? "");
registerTargetExtractor("ha:integration.uninstall", (a) => getArg(a, "domain") ?? "");
registerTargetExtractor("ha:dashboard.set", (a) => getArg(a, "path") ?? "");
registerTargetExtractor("ha:dashboard.get", (a) => getArg(a, "path") ?? "");
registerTargetExtractor("ha:script.run", (a) => getArg(a, "entity_id") ?? "");
registerTargetExtractor("ha:light.*", (a) => getArg(a, "entity_id") ?? "");
registerTargetExtractor("ha:switch.*", (a) => getArg(a, "entity_id") ?? "");
registerTargetExtractor("ha:climate.*", (a) => getArg(a, "entity_id") ?? "");

export function extractActionTarget(tool: string, args: unknown): string {
  const direct = extractors.get(tool);
  if (direct) return direct(args);

  for (const [pattern, fn] of extractors) {
    if (!pattern.endsWith("*")) continue;
    if (tool.startsWith(pattern.slice(0, -1))) return fn(args);
  }

  return "";
}
