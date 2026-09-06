import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type RunWorkflowResult = { agentCalls: number; error?: unknown };

export type RunWorkflowCapturingPromptsResult = {
  prompts: string[];
  workflowCalls: Array<{ name: string; args: unknown }>;
  error?: unknown;
};

function findMatchingDelimiter(
  source: string,
  openIndex: number,
  open: string,
  close: string,
): number {
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
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }

  throw new Error("unterminated export const meta object");
}

function findMatchingBrace(source: string, openIndex: number): number {
  return findMatchingDelimiter(source, openIndex, "{", "}");
}

function findMatchingBracket(source: string, openIndex: number): number {
  return findMatchingDelimiter(source, openIndex, "[", "]");
}

export function readNamedArray(path: string, name: string): string[] | null {
  const source = readFileSync(resolve(path), "utf8");
  const matches = [...source.matchAll(new RegExp(`\\b${name}\\s*:\\s*\\[`, "g"))];
  if (matches.length === 0) return null;
  // Exactly-once is load-bearing: a second declaration of the same allowlist
  // name would silently shadow the first, and the fixture-vs-source drift test
  // that consumes this is the only thing catching that class.
  if (matches.length !== 1) {
    throw new Error(`${path} should declare ${name} exactly once`);
  }
  const open = matches[0]!.index + matches[0]![0].length - 1;
  const close = findMatchingBracket(source, open);
  const body = source
    .slice(open + 1, close)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]!);
}

export function readRuntimeBody(path: string): string {
  const source = readFileSync(resolve(path), "utf8");
  const marker = "export const meta";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${path}: missing export const meta`);
  const equals = source.indexOf("=", start + marker.length);
  if (equals < 0) throw new Error(`${path}: missing = in export const meta`);
  const open = source.indexOf("{", equals);
  if (open < 0) throw new Error(`${path}: missing object literal in export const meta`);
  const close = findMatchingBrace(source, open);
  const after = source[close + 1] === ";" ? close + 2 : close + 1;

  return source.slice(0, start) + source.slice(after);
}

type AgentStub = (prompt: string, options?: Record<string, unknown>) => Promise<unknown>;
type WorkflowStub = (name: string, wArgs: unknown) => Promise<unknown>;

async function baseRun(
  body: string,
  args: unknown,
  agentStub: AgentStub,
  workflowStub: WorkflowStub,
): Promise<{
  agentCalls: number;
  prompts: string[];
  workflowCalls: Array<{ name: string; args: unknown }>;
  error?: unknown;
}> {
  let agentCalls = 0;
  const prompts: string[] = [];
  const workflowCalls: Array<{ name: string; args: unknown }> = [];

  const agent = async (prompt: string, options?: Record<string, unknown>) => {
    agentCalls++;
    prompts.push(String(prompt));
    return agentStub(prompt, options);
  };

  const parallel = async (items: unknown[]) =>
    Promise.all(
      items.map((item) => (typeof item === "function" ? (item as () => unknown)() : item)),
    );

  const pipeline = async (items: unknown[], ...stages: Array<(...a: unknown[]) => unknown>) =>
    stages.reduce<Promise<unknown[]>>(
      async (acc, stage) => Promise.all((await acc).map((item, i) => stage(item, items[i]))),
      Promise.resolve(items),
    );

  const phase = async (_name: string, fn?: () => unknown) => (fn ? fn() : undefined);
  const log = () => {};
  const budget = {};
  const workflow = async (name: string, wArgs: unknown) => {
    workflowCalls.push({ name, args: wArgs });
    return workflowStub(name, wArgs);
  };

  const run = new Function(
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "args",
    "budget",
    "workflow",
    `"use strict"; return (async () => {\n${body}\n})()`,
  ) as (
    a: unknown,
    p: unknown,
    pl: unknown,
    ph: unknown,
    l: unknown,
    ar: unknown,
    b: unknown,
    w: unknown,
  ) => Promise<unknown>;

  try {
    await run(agent, parallel, pipeline, phase, log, args, budget, workflow);
  } catch (error) {
    return { agentCalls, prompts, workflowCalls, error };
  }
  return { agentCalls, prompts, workflowCalls };
}

export async function runWorkflow(path: string, args: unknown): Promise<RunWorkflowResult> {
  const body = readRuntimeBody(path);
  const { agentCalls, error } = await baseRun(
    body,
    args,
    async () => ({}),
    async () => ({}),
  );
  return { agentCalls, error };
}

export async function runWorkflowCapturingPrompts(
  path: string,
  args: unknown,
): Promise<RunWorkflowCapturingPromptsResult> {
  const body = readRuntimeBody(path);
  const { prompts, workflowCalls, error } = await baseRun(
    body,
    args,
    async () => ({
      tasks: [{ task_class: "STANDARD", task_type: "implement_small", message: "stub" }],
    }),
    async () => ({}),
  );
  return { prompts, workflowCalls, error };
}
