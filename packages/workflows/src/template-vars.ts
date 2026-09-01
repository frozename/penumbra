export type TemplateVarContext = {
  now: () => Date;
  project: string;
  sessionStart: string;
  tz: string;
  cwd?: string;
  repoRoot?: string;
  filePath?: string;
  args?: Record<string, unknown>;
};

function fmtDateInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

function localHourInTz(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  return Number.parseInt(fmt.format(d), 10);
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function resolveArgsToken(
  token: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!token.startsWith("args.")) return undefined;
  const path = token.slice("args.".length);
  if (!path) return "";
  let cur: unknown = args;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return "";
    cur = (cur as Record<string, unknown>)[key];
  }
  return stringifyTemplateValue(cur);
}

export function resolveTemplateVars(s: string, ctx: TemplateVarContext): string {
  return s.replaceAll(
    /\{\{([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\}\}/g,
    (full, name: string) => {
      const argsValue = resolveArgsToken(name, ctx.args);
      if (argsValue !== undefined) return argsValue;
      const now = ctx.now();
      switch (name) {
        case "date":
        case "today":
          return fmtDateInTz(now, ctx.tz);
        case "period":
          return localHourInTz(now, ctx.tz) < 12 ? "am" : "pm";
        case "project":
          return ctx.project;
        case "session_start":
          return ctx.sessionStart;
        case "now_minus_24h":
          return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        case "cwd":
          return ctx.cwd ?? "";
        case "repo_root":
          return ctx.repoRoot ?? ctx.cwd ?? "";
        case "file_path":
          return ctx.filePath ?? "";
        default:
          return full;
      }
    },
  );
}
