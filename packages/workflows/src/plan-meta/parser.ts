import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { TaskMetaSchema, type TaskMeta } from './schema.js';

export type ParseError = { line: number; reason: string };
export type ParseResult = { tasks: TaskMeta[]; errors: ParseError[] };

function errorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function parsePlanMeta(markdown: string): ParseResult {
  const tasks: TaskMeta[] = [];
  const errors: ParseError[] = [];

  const lines = markdown.split(/\r?\n/);
  let currentBody: string[] | null = null;
  let currentLine = 0;

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

    const result = TaskMetaSchema.safeParse(parsed);
    if (!result.success) {
      errors.push({
        line: currentLine,
        reason: result.error.issues.map((issue) => issue.message).join('; '),
      });
      currentBody = null;
      return;
    }

    tasks.push(result.data);
    currentBody = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (currentBody !== null) {
      if (line === '```') {
        flushBlock();
      } else {
        currentBody.push(line);
      }
      continue;
    }

    if (line === '```yaml meta') {
      currentLine = index + 1;
      currentBody = [];
    }
  }

  // Unclosed blocks are ignored by the format contract.
  return { tasks, errors };
}

export async function parsePlanMetaFile(path: string): Promise<ParseResult> {
  return parsePlanMeta(await readFile(path, 'utf8'));
}
