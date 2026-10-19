import { readFile } from "node:fs/promises";
import YAML from "yaml";

import { type PlanHeader, PlanHeaderSchema, type TaskMeta, TaskMetaSchema } from "./schema.js";

export type ParseError = { line: number; reason: string };
export type ParseResult = { header?: PlanHeader; tasks: TaskMeta[]; errors: ParseError[] };

function errorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function invalidHeaderReason(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const detail = issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return `invalid plan header: ${detail}`;
}

export function parsePlanMeta(markdown: string): ParseResult {
  let header: PlanHeader | undefined;
  const tasks: TaskMeta[] = [];
  const errors: ParseError[] = [];

  const lines = markdown.split(/\r?\n/);
  let currentBody: string[] | null = null;
  let currentLine = 0;
  let currentKind: "task" | "header" | null = null;
  let pendingTaskHeading: string | null = null;
  let currentProseTaskIndex = -1;
  let currentProseLines: string[] = [];

  const finalizeCurrentProse = (): void => {
    if (currentProseTaskIndex < 0) {
      currentProseLines = [];
      return;
    }

    const prose = currentProseLines.join("\n").trim();
    if (prose.length > 0) {
      const task = tasks[currentProseTaskIndex];
      if (task) {
        task.body = prose;
      }
    }
    currentProseTaskIndex = -1;
    currentProseLines = [];
  };

  const flushBlock = (): void => {
    if (currentBody === null) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = YAML.parse(currentBody.join("\n"));
    } catch (error) {
      errors.push({ line: currentLine, reason: errorReason(error) });
      currentBody = null;
      return;
    }

    if (currentKind === "header") {
      const result = PlanHeaderSchema.safeParse(parsed);
      if (result.success) {
        header = result.data;
      } else {
        errors.push({ line: currentLine, reason: invalidHeaderReason(result.error.issues) });
      }
      currentBody = null;
      return;
    }

    const result = TaskMetaSchema.safeParse(parsed);
    if (!result.success) {
      errors.push({
        line: currentLine,
        reason: result.error.issues.map((issue) => issue.message).join("; "),
      });
      currentBody = null;
      return;
    }

    tasks.push({
      ...result.data,
      heading: pendingTaskHeading ?? undefined,
    });
    pendingTaskHeading = null;
    currentProseTaskIndex = tasks.length - 1;
    currentProseLines = [];
    currentBody = null;
  };

  const handleInsideBlock = (line: string): void => {
    const isCloser =
      (currentKind === "task" && line === "```") || (currentKind === "header" && line === "---");
    if (isCloser) {
      flushBlock();
    } else {
      currentBody?.push(line);
    }
  };

  const startBlockIfMatching = (line: string, index: number): boolean => {
    // Front matter only opens a document; a later --- is a markdown thematic break.
    if (index === 0 && line === "---") {
      currentLine = index + 1;
      currentKind = "header";
      currentBody = [];
      return true;
    }
    if (line === "```yaml meta") {
      currentLine = index + 1;
      currentKind = "task";
      currentBody = [];
      return true;
    }
    return false;
  };

  const processLine = (line: string, index: number): void => {
    if (line.startsWith("### ")) {
      finalizeCurrentProse();
      pendingTaskHeading = line.slice(4).trim();
      return;
    }
    if (line.startsWith("## ")) {
      finalizeCurrentProse();
      pendingTaskHeading = null;
    }
    if (currentBody !== null) {
      handleInsideBlock(line);
      return;
    }
    if (startBlockIfMatching(line, index)) {
      return;
    }
    if (currentProseTaskIndex >= 0) {
      currentProseLines.push(line);
    }
  };

  for (const [index, line] of lines.entries()) {
    processLine(line, index);
  }

  finalizeCurrentProse();
  // Unclosed blocks are ignored by the format contract.
  return { header, tasks, errors };
}

export async function parsePlanMetaFile(path: string): Promise<ParseResult> {
  return parsePlanMeta(await readFile(path, "utf8"));
}
