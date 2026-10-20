/**
 * The native replacement for the CC sandbox's `agent(prompt, {schema})`.
 *
 * CC enforces a JSON Schema on the subagent's output. WorkflowCtx has no such
 * primitive, so a structured result is a fleet dispatch plus this parser. Both
 * halves live here: renderJsonContract writes the prompt-side instruction,
 * parseStructured validates the response.
 *
 * The schema is DUCK-TYPED on safeParse. The ts loader bundles each workflow
 * with zod kept external so identity usually survives, but the daemon itself
 * refuses to rely on that (routes/workflows.ts:93-99 duck-types inputSchema),
 * and an `instanceof` check here would reject a valid schema loaded through a
 * different zod resolution.
 */
export type SafeParseSchema<T> = {
  safeParse: (value: unknown) => {
    data?: T;
    error?: { issues?: { message: string; path: (number | string | symbol)[] }[] };
    success: boolean;
  };
};

export type StructuredParseError = "invalid_json" | "no_json_block" | "schema_violation";

export type StructuredResult<T> =
  | { ok: false; error: StructuredParseError; issues?: string[] }
  | { ok: true; value: T };

type IssuePathSegment = number | string | symbol;

function formatIssuePath(path: IssuePathSegment[]): string {
  if (path.length === 0) return "(root)";
  return path.map((segment) => String(segment)).join(".");
}

function boundedIssueMessage(message: string): string {
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}

function findLastJsonBlockMatch(responseText: string): RegExpExecArray | null {
  const pattern = /```json([\s\S]*?)```/gi;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(responseText))) {
    lastMatch = match;
  }
  return lastMatch;
}

function hasUnclosedJsonFence(responseText: string, start: number): boolean {
  const pattern = /```json/gi;
  pattern.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(responseText))) {
    const close = responseText.indexOf("```", match.index + match[0].length);
    if (close === -1) return true;
    pattern.lastIndex = close + "```".length;
  }
  return false;
}

/**
 * Extract the LAST fenced json block. Last, not first: a model that drafts and
 * then revises leaves both in the transcript, and the revision is the answer.
 * Same strategy as adversarial-review's parseFindingsJson.
 */
export function extractLastJsonBlock(responseText: string | null): string | null {
  if (!responseText || responseText.length === 0) return null;
  const lastMatch = findLastJsonBlockMatch(responseText);
  return lastMatch?.[1] ?? null;
}

export function parseStructured<T>(
  responseText: string | null,
  schema: SafeParseSchema<T>,
): StructuredResult<T> {
  if (responseText === null || responseText.length === 0)
    return { error: "no_json_block", ok: false };

  const lastMatch = findLastJsonBlockMatch(responseText);
  if (lastMatch === null) {
    if (hasUnclosedJsonFence(responseText, 0)) {
      return { error: "invalid_json", ok: false };
    }
    return { error: "no_json_block", ok: false };
  }

  if (hasUnclosedJsonFence(responseText, lastMatch.index + lastMatch[0].length)) {
    return { error: "invalid_json", ok: false };
  }

  const block = lastMatch[1] ?? "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return { error: "invalid_json", ok: false };
  }

  try {
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      // Fail closed. Well-formed JSON of the wrong shape is exactly how a malformed
      // plan becomes a silently empty fan-out.
      const issues = (validated.error?.issues ?? []).map(
        (issue) => `${formatIssuePath(issue.path)}: ${issue.message}`,
      );
      return { error: "schema_violation", issues, ok: false };
    }
    return { ok: true, value: validated.data as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: "schema_violation",
      issues: [`safe_parse_error: ${boundedIssueMessage(message)}`],
    };
  }
}

/**
 * The prompt-side half of the contract. Append this to a dispatch message so
 * the worker emits something parseStructured can read.
 */
export function renderJsonContract(opts: { example: string; name: string }): string {
  return [
    `## Output format (${opts.name})`,
    "",
    "Write your reasoning as prose, then close with ONE fenced json block at the",
    "very end of your reply. Only the LAST json block is read; anything after it",
    "is ignored. The block must match this shape exactly:",
    "",
    "```json",
    opts.example,
    "```",
  ].join("\n");
}
