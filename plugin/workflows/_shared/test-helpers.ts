import type { RecallBundle, WorkflowCtx } from "@penumbra/workflows";

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

export function testWorkflowCtx<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  overrides: WorkflowCtxOverrides<TArgs> = {},
): WorkflowCtx<TArgs> {
  return {
    dispatch: () => Promise.resolve({ conversation_id: "conversation", handoff_id: "handoff" }),
    awaitChain: () =>
      Promise.resolve({ status: "timeout", final_agent: null, response_text: null }),
    cancel: (): Promise<void> => Promise.resolve(),
    fileWrite: (relativePath) => Promise.resolve(relativePath),
    config: {},
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "penumbra",
    args: {} as TArgs,
    ...overrides,
  };
}
