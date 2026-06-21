import type { ChainStartRequest, Services } from "@penumbra/core";

import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type AgentChatConfigLike = {
  agents?: Record<string, unknown>[];
  default_roles?: Record<string, string>;
  providers?: Record<string, unknown>[];
  workloads?: unknown;
  [key: string]: unknown;
};

export type WorkflowCtx<TArgs = Record<string, unknown>> = {
  dispatch(input: {
    agent: string;
    message: string;
    task_type?: string;
    parent_handoff_id?: string;
    use_worktree?: boolean;
    branch_base?: string;
    project_id?: string;
    workflowRunId?: string;
  }): Promise<{ conversation_id: string; handoff_id: string }>;
  awaitChain(
    conversationId: string,
    opts?: { timeoutMs?: number; lateResponseGraceMs?: number },
  ): Promise<{
    status: "completed" | "failed" | "timeout";
    final_agent: string | null;
    response_text: string | null;
  }>;
  fileWrite(relativePath: string, body: string): Promise<string>;
  db?: () => Database;
  config: AgentChatConfigLike;
  cwd: string;
  storageRoot: string;
  project: string;
  args: TArgs;
};

type ChainTerminalSnapshot = {
  terminal: boolean;
  status: "completed" | "failed";
  final_agent: string | null;
  response_text: string | null;
};

export type BuildWorkflowCtxDeps<TArgs = Record<string, unknown>> = {
  services: Services;
  cwd: string;
  storageRoot: string;
  project: string;
  agentchatConfig: AgentChatConfigLike;
  args?: TArgs;
  parentHandoffId?: string;
  workflowRunId?: string | null;
  chainStart: (input: ChainStartRequest) => Promise<Response> | Response;
  readChainStatus?: (conversationId: string) => Promise<ChainTerminalSnapshot>;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function resolveWritePath(inputPath: string, cwd: string, storageRoot: string): string {
  const absPath = isAbsolute(inputPath)
    ? resolve(inputPath)
    : inputPath.startsWith("./")
      ? resolve(cwd, inputPath)
      : resolve(storageRoot, inputPath);
  const realAbsPath = canonicalizePathForWrite(absPath);
  const roots = [cwd, storageRoot].map(canonicalizePathForWrite);
  const allowed = roots.some(
    (root) => realAbsPath === root || realAbsPath.startsWith(`${root}${sep}`),
  );
  if (!allowed) {
    throw new Error(`fileWrite path outside allowed roots: ${inputPath}`);
  }
  return realAbsPath;
}

function canonicalizePathForWrite(path: string): string {
  const absPath = resolve(path);
  try {
    return realpathSync(absPath);
  } catch {
    const missing: string[] = [];
    let cursor = absPath;
    for (;;) {
      missing.unshift(basename(cursor));
      const parent = dirname(cursor);
      if (parent === cursor) return absPath;
      cursor = parent;
      try {
        const realParent = realpathSync(cursor);
        return resolve(realParent, ...missing);
      } catch {
        // keep climbing — parent directory may not yet exist
      }
    }
  }
}

async function readJsonBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await res.json().catch(() => null);
  }
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

type HandoffLike = { status: string; resolved_at: string | null };

function snapshotFromHandoff(
  services: Services,
  conversationId: string,
  handoff: HandoffLike,
): ChainTerminalSnapshot {
  if (
    handoff.status !== "completed" &&
    handoff.status !== "failed" &&
    handoff.status !== "rejected"
  ) {
    return {
      terminal: false,
      status: "failed",
      final_agent: null,
      response_text: null,
    };
  }

  const responses = services.chainReader.getResponses(conversationId, "final");
  const final = responses[0] ?? null;
  const hasResponse = typeof final?.text === "string" && final.text.length > 0;

  if (handoff.status === "completed" && handoff.resolved_at !== null && !hasResponse) {
    return {
      terminal: true,
      status: "failed",
      final_agent: null,
      response_text: null,
    };
  }

  const status = handoff.status === "completed" ? "completed" : "failed";
  const responseText = hasResponse ? final.text : null;

  return {
    terminal: true,
    status,
    final_agent: final?.agent ?? null,
    response_text: responseText,
  };
}

function readChainSnapshotSync(services: Services, conversationId: string): ChainTerminalSnapshot {
  const notTerminal: ChainTerminalSnapshot = {
    terminal: false,
    status: "failed",
    final_agent: null,
    response_text: null,
  };

  const getRootForConversation = (
    services.handoffReader as {
      getRootForConversation?: (
        conversationId: string,
      ) => ReturnType<Services["handoffReader"]["getLatestForConversation"]>;
    }
  ).getRootForConversation;

  if (typeof getRootForConversation === "function") {
    const root = getRootForConversation.call(services.handoffReader, conversationId);
    if (!root) return notTerminal;
    return snapshotFromHandoff(services, conversationId, root);
  }

  const latest = services.handoffReader.getLatestForConversation(conversationId);
  if (!latest) return notTerminal;
  return snapshotFromHandoff(services, conversationId, latest);
}

function defaultReadChainStatus(
  services: Services,
  conversationId: string,
): Promise<ChainTerminalSnapshot> {
  return Promise.resolve(readChainSnapshotSync(services, conversationId));
}

type DispatchInput = Parameters<WorkflowCtx["dispatch"]>[0];
type DispatchResult = Awaited<ReturnType<WorkflowCtx["dispatch"]>>;
type AwaitChainResult = Awaited<ReturnType<WorkflowCtx["awaitChain"]>>;

function buildChainStartRequest<TArgs>(
  input: DispatchInput,
  deps: BuildWorkflowCtxDeps<TArgs>,
): ChainStartRequest & { workflow_run_id?: string } {
  const req: ChainStartRequest & { workflow_run_id?: string } = {
    initial_agent: input.agent,
    message: input.message,
    dispatch_kind: "workflow",
  };
  if (deps.workflowRunId) req.workflow_run_id = deps.workflowRunId;
  if (input.task_type) req.task_type = input.task_type as ChainStartRequest["task_type"];
  const parentHandoff = input.parent_handoff_id ?? deps.parentHandoffId;
  if (parentHandoff) req.parent_handoff_id = parentHandoff;
  if (input.use_worktree !== undefined) req.use_worktree = input.use_worktree;
  if (input.branch_base) req.branch_base = input.branch_base;
  if (input.workflowRunId) req.workflow_run_id = input.workflowRunId;
  const effectiveProjectId = input.project_id ?? deps.project;
  if (effectiveProjectId) req.project_id = effectiveProjectId;
  return req;
}

async function dispatchImpl<TArgs>(
  input: DispatchInput,
  deps: BuildWorkflowCtxDeps<TArgs>,
): Promise<DispatchResult> {
  const req = buildChainStartRequest(input, deps);
  const res = await deps.chainStart(req);
  const payload = await readJsonBody(res);
  if (!res.ok) {
    throw new Error(
      `chain.start failed with ${String(res.status)}: ${
        payload ? JSON.stringify(payload) : `HTTP ${String(res.status)}`
      }`,
    );
  }

  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const conversationId = payloadObj?.conversation_id;
  const handoffId = payloadObj?.handoff_id;
  if (typeof conversationId !== "string" || typeof handoffId !== "string") {
    throw new Error("chain.start response missing conversation_id/handoff_id");
  }
  return { conversation_id: conversationId, handoff_id: handoffId };
}

type AwaitChainDeps = {
  readChainStatus: (conversationId: string) => Promise<ChainTerminalSnapshot>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
};

async function awaitChainImpl(
  conversationId: string,
  opts: { timeoutMs?: number; lateResponseGraceMs?: number } | undefined,
  ac: AwaitChainDeps,
): Promise<AwaitChainResult> {
  const timeoutMs = opts?.timeoutMs ?? 120000;
  const lateResponseGraceMs = opts?.lateResponseGraceMs ?? 90000;
  const start = ac.now();
  let intervalMs = ac.pollIntervalMs;
  let firstTerminalAt: number | null = null;
  let lastTerminalSnapshot: ChainTerminalSnapshot | null = null;

  while (ac.now() - start < timeoutMs) {
    const status = await ac.readChainStatus(conversationId);
    if (status.terminal) {
      const hasResponse = status.response_text !== null && status.response_text.length > 0;
      if (hasResponse) {
        return {
          status: status.status,
          final_agent: status.final_agent,
          response_text: status.response_text,
        };
      }
      lastTerminalSnapshot = status;
      firstTerminalAt ??= ac.now();
      if (ac.now() - firstTerminalAt >= lateResponseGraceMs) {
        return {
          status: status.status,
          final_agent: status.final_agent,
          response_text: status.response_text,
        };
      }
    }
    await ac.sleep(intervalMs);
    intervalMs = Math.min(intervalMs * 1.5, 2000);
  }

  if (lastTerminalSnapshot) {
    return {
      status: lastTerminalSnapshot.status,
      final_agent: lastTerminalSnapshot.final_agent,
      response_text: lastTerminalSnapshot.response_text,
    };
  }

  return {
    status: "timeout",
    final_agent: null,
    response_text: null,
  };
}

async function fileWriteImpl(
  relativePath: string,
  body: string,
  cwd: string,
  storageRoot: string,
): Promise<string> {
  const path = resolveWritePath(relativePath, cwd, storageRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
  return path;
}

export function buildWorkflowCtx<TArgs = Record<string, unknown>>(
  deps: BuildWorkflowCtxDeps<TArgs>,
): WorkflowCtx<TArgs> {
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> =>
      new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const now = deps.now ?? ((): number => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? 200;
  const readChainStatus =
    deps.readChainStatus ??
    ((conversationId: string): Promise<ChainTerminalSnapshot> =>
      defaultReadChainStatus(deps.services, conversationId));
  let workflowDb: Database | null = null;
  const ac: AwaitChainDeps = { readChainStatus, sleep, now, pollIntervalMs };

  return {
    dispatch: (input): Promise<DispatchResult> => dispatchImpl(input, deps),
    awaitChain: (conversationId, opts): Promise<AwaitChainResult> =>
      awaitChainImpl(conversationId, opts, ac),
    fileWrite: (relativePath, body): Promise<string> =>
      fileWriteImpl(relativePath, body, deps.cwd, deps.storageRoot),
    db: (): Database => {
      workflowDb ??= new Database(join(deps.storageRoot, "db.sqlite"), { readonly: true });
      return workflowDb;
    },
    config: deps.agentchatConfig,
    cwd: deps.cwd,
    storageRoot: deps.storageRoot,
    project: deps.project,
    args: deps.args ?? ({} as TArgs),
  };
}
