import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ChainStartRequest, Services } from '@penumbra/core';

export type AgentChatConfigLike = {
  agents?: Array<Record<string, unknown>>;
  default_roles?: Record<string, string>;
  providers?: Array<Record<string, unknown>>;
  review_personas?: unknown;
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
  }): Promise<{ conversation_id: string; handoff_id: string }>;
  awaitChain(
    conversationId: string,
    opts?: { timeoutMs?: number },
  ): Promise<{
    status: 'completed' | 'failed' | 'timeout';
    final_agent: string | null;
    response_text: string | null;
  }>;
  fileWrite(relativePath: string, body: string): Promise<string>;
  config: AgentChatConfigLike;
  cwd: string;
  storageRoot: string;
  project: string;
  args: TArgs;
};

type ChainTerminalSnapshot = {
  terminal: boolean;
  status: 'completed' | 'failed';
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
  chainStart: (input: ChainStartRequest) => Promise<Response> | Response;
  readChainStatus?: (conversationId: string) => Promise<ChainTerminalSnapshot>;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

function resolveWritePath(inputPath: string, cwd: string, storageRoot: string): string {
  if (isAbsolute(inputPath)) return resolve(inputPath);
  if (inputPath.startsWith('./')) return resolve(cwd, inputPath);
  return resolve(storageRoot, inputPath);
}

async function readJsonBody(res: Response): Promise<any> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return await res.json().catch(() => null);
  }
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function defaultReadChainStatus(services: Services, conversationId: string): Promise<ChainTerminalSnapshot> {
  const snapshotFromHandoff = (handoff: { status: string; resolved_at: string | null }) => {
    if (handoff.status !== 'completed' && handoff.status !== 'failed' && handoff.status !== 'rejected') {
      return {
        terminal: false,
        status: 'failed',
        final_agent: null,
        response_text: null,
      } as const;
    }

    const responses = services.chainReader.getResponses(conversationId, 'final');
    const final = responses[0] ?? null;
    const hasResponse = typeof final?.text === 'string' && final.text.length > 0;

    if (handoff.status === 'completed' && handoff.resolved_at !== null && !hasResponse) {
      return {
        terminal: true,
        status: 'failed',
        final_agent: null,
        response_text: null,
      } as const;
    }

    const status = handoff.status === 'completed' ? 'completed' : 'failed';
    const responseText = hasResponse ? final.text : null;

    return {
      terminal: true,
      status,
      final_agent: final?.agent ?? null,
      response_text: responseText,
    } as const;
  };

  let rootLookupOk = false;
  let root: ReturnType<Services['handoffReader']['getLatestForConversation']> = null;
  const getRootForConversation = (services.handoffReader as {
    getRootForConversation?: (conversationId: string) => ReturnType<Services['handoffReader']['getLatestForConversation']>;
  }).getRootForConversation;
  if (typeof getRootForConversation === 'function') {
    rootLookupOk = true;
    root = getRootForConversation.call(services.handoffReader, conversationId);
  }

  if (rootLookupOk && !root) {
    return {
      terminal: false,
      status: 'failed',
      final_agent: null,
      response_text: null,
    };
  }

  if (rootLookupOk && root) {
    return snapshotFromHandoff(root);
  }

  const latest = services.handoffReader.getLatestForConversation(conversationId);
  if (!latest) {
    return {
      terminal: false,
      status: 'failed',
      final_agent: null,
      response_text: null,
    };
  }
  return snapshotFromHandoff(latest);
}

export function buildWorkflowCtx<TArgs = Record<string, unknown>>(deps: BuildWorkflowCtxDeps<TArgs>): WorkflowCtx<TArgs> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? 250;
  const readChainStatus = deps.readChainStatus ?? ((conversationId: string) =>
    defaultReadChainStatus(deps.services, conversationId));

  return {
    async dispatch(input) {
      const req: ChainStartRequest = {
        initial_agent: input.agent,
        message: input.message,
      };

      if (input.task_type) {
        req.task_type = input.task_type as ChainStartRequest['task_type'];
      }
      if (input.parent_handoff_id ?? deps.parentHandoffId) {
        req.parent_handoff_id = input.parent_handoff_id ?? deps.parentHandoffId;
      }
      if (input.use_worktree !== undefined) {
        req.use_worktree = input.use_worktree;
      }
      if (input.branch_base) {
        req.branch_base = input.branch_base;
      }

      const res = await deps.chainStart(req);
      const payload = await readJsonBody(res);
      if (!res.ok) {
        throw new Error(
          `chain.start failed with ${res.status}: ${
            payload ? JSON.stringify(payload) : `HTTP ${res.status}`
          }`,
        );
      }

      const conversationId = payload?.conversation_id;
      const handoffId = payload?.handoff_id;
      if (typeof conversationId !== 'string' || typeof handoffId !== 'string') {
        throw new Error('chain.start response missing conversation_id/handoff_id');
      }
      return { conversation_id: conversationId, handoff_id: handoffId };
    },

    async awaitChain(conversationId, opts) {
      const timeoutMs = opts?.timeoutMs ?? 120000;
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        const status = await readChainStatus(conversationId);
        if (status.terminal) {
          return {
            status: status.status,
            final_agent: status.final_agent,
            response_text: status.response_text,
          };
        }
        await sleep(pollIntervalMs);
      }

      return {
        status: 'timeout',
        final_agent: null,
        response_text: null,
      };
    },

    async fileWrite(relativePath, body) {
      const path = resolveWritePath(relativePath, deps.cwd, deps.storageRoot);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, 'utf8');
      return path;
    },

    config: deps.agentchatConfig,
    cwd: deps.cwd,
    storageRoot: deps.storageRoot,
    project: deps.project,
    args: (deps.args ?? ({} as TArgs)),
  };
}
