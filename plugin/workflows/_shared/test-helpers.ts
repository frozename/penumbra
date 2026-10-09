import type { ScratchWorktreeHandle } from "@penumbra/core";
import type { RecallBundle, WorkflowCtx } from "@penumbra/workflows";

import { agentPoolToNames } from "./pool-resolver.js";

type WorkflowCtxOverrides<TArgs> = Partial<Omit<WorkflowCtx<TArgs>, "args">> & {
  args?: TArgs;
};

export function emptyRecall(overrides: Partial<RecallBundle> = {}): RecallBundle {
  return {
    byKey: overrides.byKey ?? {},
    warnings: overrides.warnings ?? [],
    estimatedTokens: overrides.estimatedTokens ?? 0,
  };
}

function collectSeatNames(source: unknown, key: string, out: Set<string>): void {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const value of Object.values(source)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const name of agentPoolToNames((value as Record<string, unknown>)[key])) {
      out.add(name);
    }
  }
}

// Workflows dispatch under review_readonly, which only admits seats that can
// enforce the profile. Test fixtures name seats via personas.*.preferred_agent
// and workloads.*.synthesizer without an agents registry; an explicit
// config.agents list is authoritative and never auto-augmented.
function withEnforcingSeatDefaults(config: WorkflowCtx["config"]): WorkflowCtx["config"] {
  if (config.agents !== undefined) return config;
  const names = new Set<string>();
  collectSeatNames(config.personas, "preferred_agent", names);
  collectSeatNames(config.workloads, "synthesizer", names);
  if (names.size === 0) return config;
  return {
    ...config,
    agents: [...names].map((name) => ({
      name,
      roles: ["reviewer", "planner"],
      adapter: "openai-compat-http",
    })),
  };
}

// Default scratch stub for P6 workflows: a fake daemon-owned checkout at a
// fixed test path with a releaseCalls spy for the workflow's release path.
export type StubScratchWorktree = NonNullable<WorkflowCtx["scratchWorktree"]> & {
  acquireCalls: ({ ref?: string } | undefined)[];
  releaseCalls: { keep_reason?: string }[];
};

export function stubScratchWorktree(
  path = "/tmp/scratch",
  opts?: { project_id?: string | null },
): StubScratchWorktree {
  const acquireCalls: ({ ref?: string } | undefined)[] = [];
  const releaseCalls: { keep_reason?: string }[] = [];
  return {
    acquire: (acquireOpts?: { ref?: string }): Promise<ScratchWorktreeHandle> => {
      acquireCalls.push(acquireOpts);
      return Promise.resolve({
        owner_run_id: "test-run",
        path,
        sha: "0".repeat(40),
        repo_root: "/tmp/repo",
        project_id: opts?.project_id ?? null,
        release: (opts?: { keep_reason?: string }) => {
          releaseCalls.push(opts ?? {});
          return Promise.resolve({ kept: opts?.keep_reason !== undefined });
        },
      });
    },
    acquireCalls,
    releaseCalls,
  };
}

export function testWorkflowCtx<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  overrides: WorkflowCtxOverrides<TArgs> = {},
): WorkflowCtx<TArgs> {
  return {
    dispatch: () => Promise.resolve({ conversation_id: "conversation", handoff_id: "handoff" }),
    awaitChain: () =>
      Promise.resolve({ status: "timeout", final_agent: null, response_text: null }),
    cancel: (): Promise<void> => Promise.resolve(),
    fileWrite: (relativePath) => Promise.resolve(relativePath),
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "penumbra",
    scratchWorktree: stubScratchWorktree(),
    args: {} as TArgs,
    ...overrides,
    config: withEnforcingSeatDefaults(overrides.config ?? {}),
  };
}
