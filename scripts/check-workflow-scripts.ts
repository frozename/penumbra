import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";

const WORKFLOW_DIR = ".claude/workflows";

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  throw new Error("unterminated export const meta object");
}

function extractMeta(source: string): { body: string; metaSource: string } {
  const marker = "export const meta";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("missing export const meta");
  const equals = source.indexOf("=", start + marker.length);
  if (equals < 0) throw new Error("missing = in export const meta");
  const open = source.indexOf("{", equals);
  if (open < 0) throw new Error("missing object literal in export const meta");
  const close = findMatchingBrace(source, open);
  const after = source[close + 1] === ";" ? close + 2 : close + 1;

  return {
    metaSource: source.slice(open, close + 1),
    body: source.slice(0, start) + source.slice(after),
  };
}

function hasNonEmptyStringProperty(source: string, property: string): boolean {
  let objectDepth = 0;
  let arrayDepth = 0;
  let lineComment = false;
  let blockComment = false;

  const skipWhitespace = (index: number): number => {
    while (/\s/.test(source[index] ?? "")) index++;
    return index;
  };

  const readStringLiteral = (
    index: number,
  ): { value: string; end: number; quote: string } | null => {
    const quote = source[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") return null;

    let value = "";
    let escaped = false;
    for (let i = index + 1; i < source.length; i++) {
      const ch = source[i];
      if (escaped) {
        value += ch ?? "";
        escaped = false;
      } else if (ch === "\\") {
        value += ch;
        escaped = true;
      } else if (ch === quote) {
        return { value, end: i + 1, quote };
      } else {
        value += ch ?? "";
      }
    }

    return null;
  };

  const hasMatchingValue = (colonIndex: number): boolean => {
    const valueStart = skipWhitespace(colonIndex + 1);
    const literal = readStringLiteral(valueStart);
    if (!literal) return false;
    if (literal.quote === "`" && literal.value.includes("${")) return false;
    return literal.value.trim().length > 0;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      if (objectDepth === 1 && arrayDepth === 0) {
        const literal = readStringLiteral(i);
        if (!literal) return false;
        const colon = skipWhitespace(literal.end);
        if (literal.value === property && source[colon] === ":" && hasMatchingValue(colon)) {
          return true;
        }
        i = literal.end - 1;
        continue;
      }

      const literal = readStringLiteral(i);
      if (!literal) return false;
      i = literal.end - 1;
      continue;
    }

    if (ch === "{") {
      objectDepth++;
      continue;
    }
    if (ch === "}") {
      objectDepth--;
      continue;
    }
    if (ch === "[") {
      arrayDepth++;
      continue;
    }
    if (ch === "]") {
      arrayDepth--;
      continue;
    }

    if (objectDepth === 1 && arrayDepth === 0 && /[$A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (/[$\w]/.test(source[end] ?? "")) end++;
      const key = source.slice(i, end);
      const colon = skipWhitespace(end);
      if (key === property && source[colon] === ":" && hasMatchingValue(colon)) {
        return true;
      }
      i = end - 1;
    }
  }

  return false;
}

function checkFile(path: string): string | null {
  try {
    const source = readFileSync(path, "utf8");
    const { body, metaSource } = extractMeta(source);
    new Script(`(${metaSource});`);
    if (!hasNonEmptyStringProperty(metaSource, "name")) {
      throw new Error("meta.name must be a non-empty string");
    }
    if (!hasNonEmptyStringProperty(metaSource, "description")) {
      throw new Error("meta.description must be a non-empty string");
    }
    new Script(`(async () => {\n${body}\n})();`);
    return null;
  } catch (error) {
    return `${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const failures = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith(".js"))
  .sort()
  .map((name) => checkFile(join(WORKFLOW_DIR, name)))
  .filter((failure): failure is string => Boolean(failure));

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
