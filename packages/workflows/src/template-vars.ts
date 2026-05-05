export type TemplateVarContext = {
  now: () => Date;
  project: string;
  sessionStart: string;
  tz: string;
  filePath?: string;
};

function fmtDateInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

function localHourInTz(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  return Number.parseInt(fmt.format(d), 10);
}

export function resolveTemplateVars(s: string, ctx: TemplateVarContext): string {
  return s.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/g, (full, name: string) => {
    const now = ctx.now();
    switch (name) {
      case 'date':
      case 'today':
        return fmtDateInTz(now, ctx.tz);
      case 'period':
        return localHourInTz(now, ctx.tz) < 12 ? 'am' : 'pm';
      case 'project':
        return ctx.project;
      case 'session_start':
        return ctx.sessionStart;
      case 'file_path':
        return ctx.filePath ?? '';
      default:
        return full;
    }
  });
}
