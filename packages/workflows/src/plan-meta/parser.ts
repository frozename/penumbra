import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { PlanHeaderSchema, TaskMetaSchema, type PlanHeader, type TaskMeta } from './schema.js';

export type ParseError = { line: number; reason: string };
export type ParseResult = { header?: PlanHeader; tasks: TaskMeta[]; errors: ParseError[] };

function errorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function parsePlanMeta(markdown: string): ParseResult {
  let header: PlanHeader | undefined;
  const tasks: TaskMeta[] = [];
  const errors: ParseError[] = [];

  const lines = markdown.split(/\r?\n/);
  let currentBody: string[] | null = null;
  let currentLine = 0;
  let currentKind: 'task' | 'header' | null = null;
  let pendingTaskHeading: string | null = null;
  let currentProseTaskIndex: number | null = null;
  let currentProseLines: string[] = [];

  const finalizeCurrentProse = () => {
    if (currentProseTaskIndex === null) {
      currentProseLines = [];
      return;
    }

    const prose = currentProseLines.join('\n').trim();
    if (prose.length > 0) {
      const task = tasks[currentProseTaskIndex];
      if (task) {
        task.body = prose;
      }
    }
    currentProseTaskIndex = null;
    currentProseLines = [];
  };

  const flushBlock = () => {
    if (currentBody === null) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = YAML.parse(currentBody.join('\n'));
    } catch (error) {
      errors.push({ line: currentLine, reason: errorReason(error) });
      currentBody = null;
      return;
    }

    if (currentKind === 'header') {
      const result = PlanHeaderSchema.safeParse(parsed);
      if (result.success) {
        header = result.data;
      }
      currentBody = null;
      return;
    }

    const result = TaskMetaSchema.safeParse(parsed);
    if (!result.success) {
      errors.push({
        line: currentLine,
        reason: result.error.issues.map((issue) => issue.message).join('; '),
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

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('### ')) {
      finalizeCurrentProse();
      pendingTaskHeading = line.slice(4).trim();
      continue;
    }

    if (line.startsWith('## ')) {
      finalizeCurrentProse();
      pendingTaskHeading = null;
    }

    if (currentBody !== null) {
      if ((currentKind === 'task' && line === '```') || (currentKind === 'header' && line === '---')) {
        flushBlock();
      } else {
        currentBody.push(line);
      }
      continue;
    }

    if (!header && line === '---') {
      currentLine = index + 1;
      currentKind = 'header';
      currentBody = [];
      continue;
    }

    if (line === '```yaml meta') {
      currentLine = index + 1;
      currentKind = 'task';
      currentBody = [];
      continue;
    }

    if (currentProseTaskIndex !== null) {
      currentProseLines.push(line);
    }
  }

  finalizeCurrentProse();
  // Unclosed blocks are ignored by the format contract.
  return { header, tasks, errors };
}

export async function parsePlanMetaFile(path: string): Promise<ParseResult> {
  return parsePlanMeta(await readFile(path, 'utf8'));
}
