type RenderOpts = { warnings?: string[] };
type Scope = Record<string, unknown>;
type BlockKind = "each" | "if";

const PATH = "[a-zA-Z0-9_.]+";

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

type ClosingMatch = { end: number; start: number };

function findClosing(template: string, start: number, block: BlockKind): ClosingMatch | undefined {
  const blockRe = new RegExp(`\\{\\{(#${block}\\s+${PATH}|\\/${block})\\}\\}`, "g");
  blockRe.lastIndex = start;
  let depth = 1;

  for (let match = blockRe.exec(template); match !== null; match = blockRe.exec(template)) {
    const tag = match[1];
    if (tag?.startsWith("#")) {
      depth += 1;
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return { end: blockRe.lastIndex, start: match.index };
    }
  }

  return undefined;
}

function stringifyValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function renderValue(path: string, scope: Scope, opts: RenderOpts): string {
  const value = lookup(scope, path);
  if (value === undefined || value === null) {
    opts.warnings?.push(`template: {{${path}}} missing`);
    return "";
  }
  return stringifyValue(value);
}

function renderEach(path: string, inner: string, scope: Scope, opts: RenderOpts): string {
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
}

function renderIf(path: string, inner: string, scope: Scope, opts: RenderOpts): string {
  const value = lookup(scope, path);
  const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
  return truthy ? renderBlock(inner, scope, opts) : "";
}

type RenderedBlock = { end: number; text: string };
type RenderedToken = { end: number; text: string };

function renderOpenedBlock(
  template: string,
  tokenEnd: number,
  block: BlockKind,
  path: string,
  scope: Scope,
  opts: RenderOpts,
): RenderedBlock | undefined {
  const closing = findClosing(template, tokenEnd, block);
  if (closing === undefined) return undefined;

  const inner = template.slice(tokenEnd, closing.start);
  const text =
    block === "each" ? renderEach(path, inner, scope, opts) : renderIf(path, inner, scope, opts);
  return { end: closing.end, text };
}

function renderToken(
  template: string,
  tokenEnd: number,
  raw: string,
  eachPath: string | undefined,
  ifPath: string | undefined,
  valuePath: string | undefined,
  scope: Scope,
  opts: RenderOpts,
): RenderedToken {
  const blockPath = eachPath ?? ifPath;
  if (blockPath !== undefined) {
    const block = eachPath !== undefined ? "each" : "if";
    return (
      renderOpenedBlock(template, tokenEnd, block, blockPath, scope, opts) ?? {
        end: tokenEnd,
        text: raw,
      }
    );
  }

  return {
    end: tokenEnd,
    text: valuePath === undefined ? raw : renderValue(valuePath, scope, opts),
  };
}

function renderBlock(template: string, scope: Scope, opts: RenderOpts): string {
  const tokenRe = new RegExp(
    `\\{\\{(?:#each\\s+(${PATH})|#if\\s+(${PATH})|(${PATH})|\\/each|\\/if)\\}\\}`,
    "g",
  );
  let out = "";
  let cursor = 0;

  for (let match = tokenRe.exec(template); match !== null; match = tokenRe.exec(template)) {
    const [raw = "", eachPath, ifPath, valuePath] = match;
    const rendered = renderToken(
      template,
      tokenRe.lastIndex,
      raw,
      eachPath,
      ifPath,
      valuePath,
      scope,
      opts,
    );
    out += template.slice(cursor, match.index);
    out += rendered.text;
    cursor = rendered.end;
    tokenRe.lastIndex = rendered.end;
  }

  return out + template.slice(cursor);
}

export function renderTemplate(template: string, scope: Scope, opts: RenderOpts = {}): string {
  return renderBlock(template, scope, opts);
}
