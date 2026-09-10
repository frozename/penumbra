import "../../setup";
import type { DispatchLandAccepted, DispatchLandTask, HandoffRow } from "@penumbra/api-contract";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getByLabelText, getByRole } from "@testing-library/dom";
import { fireEvent } from "@testing-library/react";
import { mock } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { DaemonClient } from "@src/api/client";
import { DaemonHttpError } from "@src/api/errors";
import { makeDispatchAuditResponse } from "@src/modules/handoffs/fixtures";

export function makeWrapper(initialRoute = "/"): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialRoute]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return { Wrapper, client };
}

export function typeIntoInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: value.slice(-1) || "x" });
  fireEvent.input(input, { target: { value } });
  fireEvent.keyUp(input, { key: value.slice(-1) || "x" });
}

export function makeManualScheduler(): {
  scheduler: typeof setTimeout;
  tick: () => void;
  pending: () => number;
} {
  const queue: (() => void)[] = [];
  const scheduler = ((cb: () => void) => {
    queue.push(cb);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  function tick(): void {
    const cbs = queue.splice(0);
    for (const cb of cbs) cb();
  }
  function pending(): number {
    return queue.length;
  }
  return { scheduler, tick, pending };
}

export function makeDispatchLandTask(overrides: Partial<DispatchLandTask> = {}): DispatchLandTask {
  return {
    task_id: "t-1",
    handoff_id: "h-abc12345",
    status: "done",
    created_at: "2026-09-07T10:00:00.000Z",
    started_at: null,
    finished_at: null,
    result: {
      ok: true,
      commit_sha: "abc123def456",
      message_subject: "feat: test",
      branch_deleted: true,
      pr_closed: false,
      worktree_torn_down: true,
    },
    error: null,
    ...overrides,
  };
}

export interface ClientMocks {
  audit: ReturnType<typeof mock>;
  land: ReturnType<typeof mock>;
  task: ReturnType<typeof mock>;
  fail: ReturnType<typeof mock>;
  list: ReturnType<typeof mock>;
  client: DaemonClient;
}

export function makeClient(opts?: {
  auditResponse?: ReturnType<typeof makeDispatchAuditResponse>;
  landResponse?: DispatchLandAccepted;
  landThrows?: DaemonHttpError;
  taskResponses?: ((taskId: string) => DispatchLandTask)[];
  taskThrows?: DaemonHttpError;
  failResponse?: unknown;
  failThrows?: DaemonHttpError;
  listResponse?: HandoffRow[];
}): ClientMocks {
  const audit = mock(async () => opts?.auditResponse ?? makeDispatchAuditResponse());
  const land = mock<DaemonClient["dispatchLand"]["land"]>(async (_body) => {
    if (opts?.landThrows) throw opts.landThrows;
    return (
      opts?.landResponse ?? {
        ok: true,
        task_id: "t-1",
        status: "queued" as const,
      }
    );
  });
  let taskCallIdx = 0;
  const task = mock<DaemonClient["dispatchLand"]["task"]>(async (taskId: string) => {
    if (opts?.taskThrows) throw opts.taskThrows;
    const responses = opts?.taskResponses ?? [];
    const fn = responses[taskCallIdx] ?? responses[responses.length - 1];
    taskCallIdx += 1;
    return fn ? fn(taskId) : makeDispatchLandTask({ task_id: taskId, status: "done" });
  });
  const fail = mock<DaemonClient["handoffs"]["fail"]>(async (id: string, _body) => {
    if (opts?.failThrows) throw opts.failThrows;
    return (opts?.failResponse ?? {
      handoff_id: id,
      status: "failed" as const,
    }) as Awaited<ReturnType<DaemonClient["handoffs"]["fail"]>>;
  });
  const list = mock(async () => ({
    handoffs: opts?.listResponse ?? [],
  }));
  const client = {
    dispatchAudit: { audit },
    dispatchLand: { land, task },
    handoffs: { fail, list },
  } as unknown as DaemonClient;
  return { audit, land, task, fail, list, client };
}

export function fillConfirm(container: HTMLElement, reason: string, target: string): void {
  const dialog = getByRole(container, "dialog");
  const reasonField = getByLabelText(container, "Reason") as HTMLTextAreaElement;
  typeIntoInput(reasonField, reason);
  if (target) {
    const targetField = getByLabelText(container, "Confirmation target") as HTMLInputElement;
    typeIntoInput(targetField, target);
  }
  const confirmBtn = getByRole(dialog, "button", { name: "Confirm" }) as HTMLButtonElement;
  fireEvent.click(confirmBtn);
}

// Re-exports for test convenience
export { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
export { ToastProvider } from "@src/ui/Toast";
