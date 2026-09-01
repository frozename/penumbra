import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import { type WorkflowSpec, WorkflowSpecSchema } from "../schema.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const LEADING_BLANK_LINES_RE = /^(?:[ \t]*\r?\n)+/;

function templateBody(body: string): string {
  return body.replace(LEADING_BLANK_LINES_RE, "");
}

export function loadMarkdownPlaybook(path: string): WorkflowSpec {
  const text = readFileSync(path, "utf8");
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    throw new Error(`playbook ${path}: missing or malformed frontmatter`);
  }
  const [, fm = "", body = ""] = match;
  const parsed = parseYaml(fm) as Record<string, unknown>;

  const run = parsed.run as { kind?: string; template?: string } | undefined;
  if (run?.kind === "markdown-template" && run.template === undefined) {
    parsed.run = { ...run, template: templateBody(body) };
  }

  return WorkflowSpecSchema.parse(parsed);
}
