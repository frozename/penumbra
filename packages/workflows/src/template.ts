type RenderOpts = { warnings?: string[] };
type Scope = Record<string, unknown>;

function lookup(scope: Scope, path: string): unknown {
  if (path === ".") return scope["."];
  const parts = path.split(".");
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function renderBlock(template: string, scope: Scope, opts: RenderOpts): string {
  let out = template.replaceAll(
    /\{\{#each\s+([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_m: string, path: string, inner: string) => {
      const arr = lookup(scope, path);
      if (!Array.isArray(arr)) {
        opts.warnings?.push(`template: {{#each ${path}}} expected array`);
        return "";
      }
      return arr
        .map((item: unknown) => {
          const child =
            typeof item === "object" && item !== null
              ? { ...scope, ...(item as Scope), ".": item }
              : { ...scope, ".": item };
          return renderBlock(inner, child, opts);
        })
        .join("");
    },
  );

  out = out.replaceAll(
    /\{\{#if\s+([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_m: string, path: string, inner: string) => {
      const v = lookup(scope, path);
      const truthy = Array.isArray(v) ? v.length > 0 : Boolean(v);
      return truthy ? renderBlock(inner, scope, opts) : "";
    },
  );

  out = out.replaceAll(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_m: string, path: string) => {
    const v = lookup(scope, path);
    if (v === undefined || v === null) {
      opts.warnings?.push(`template: {{${path}}} missing`);
      return "";
    }
    return typeof v === "string" ? v : JSON.stringify(v);
  });

  return out;
}

export function renderTemplate(template: string, scope: Scope, opts: RenderOpts = {}): string {
  return renderBlock(template, scope, opts);
}
