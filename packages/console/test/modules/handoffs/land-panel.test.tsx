import "../../setup";
import type { DispatchLandTask, HandoffRow } from "@penumbra/api-contract";

import { useQuery } from "@tanstack/react-query";
import { getByRole } from "@testing-library/dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { DaemonHttpError } from "@src/api/errors";
import { handoffsByStatus } from "@src/lib/query-keys";
import { makeDispatchAuditResponse } from "@src/modules/handoffs/fixtures";
import { LandPanel } from "@src/modules/handoffs/LandPanel";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";

import {
  type ClientMocks,
  ConfirmDialogProvider,
  fillConfirm,
  makeClient,
  makeDispatchLandTask,
  makeManualScheduler,
  makeWrapper,
  ToastProvider,
  typeIntoInput,
} from "./land-panel-helpers";

const HANDOFF_ID = "h-abc12345";

beforeEach(() => {
  useUIStore.setState({ activeModule: "handoffs", explorerCollapsed: false });
  useDaemonStore.setState({
    baseUrl: "http://daemon.test/",
    token: "test-token",
    health: "unknown",
    lastHealthAt: null,
    sessionInvalid: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("LandPanel", () => {
  test("A: Land button disabled with tooltip until audit recommends accept; loading/error/null stay disabled", async () => {
    const mocks = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "non_terminal_stale",
        recommended_action: "wait",
      }),
    });
    const { Wrapper } = makeWrapper();
    const view = render(
      <Wrapper>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={mocks.client} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(mocks.audit).toHaveBeenCalledWith(HANDOFF_ID);
    });

    const landBtn = view.container.querySelector(
      '[data-testid="land-button"]',
    ) as HTMLButtonElement;
    expect(landBtn).toBeTruthy();
    expect(landBtn.disabled).toBe(true);
    expect(landBtn.getAttribute("title")).toBe("audit does not recommend accept");
    view.unmount();

    // Loading (pending audit) → Land disabled
    let resolveAudit: (v: ReturnType<typeof makeDispatchAuditResponse>) => void = () => {};
    const pendingAudit = new Promise<ReturnType<typeof makeDispatchAuditResponse>>((r) => {
      resolveAudit = r;
    });
    const loadingClient = {
      dispatchAudit: { audit: () => pendingAudit },
    } as unknown as ClientMocks["client"];
    const view2 = render(
      <Wrapper>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={loadingClient} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </Wrapper>,
    );
    expect(
      (view2.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    resolveAudit(makeDispatchAuditResponse());
    view2.unmount();

    // Error audit → Land disabled
    const errClient = {
      dispatchAudit: { audit: async () => await Promise.reject(new Error("network")) },
    } as unknown as ClientMocks["client"];
    const view3 = render(
      <Wrapper>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={errClient} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </Wrapper>,
    );
    await waitFor(() => {
      expect(
        (view3.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
    view3.unmount();

    // Null report → Land disabled
    const nullClient = {
      dispatchAudit: { audit: async () => ({ report: null }) },
    } as unknown as ClientMocks["client"];
    const view4 = render(
      <Wrapper>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={nullClient} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </Wrapper>,
    );
    await waitFor(() => {
      expect(
        (view4.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
    view4.unmount();

    // Accept audit → Land enabled
    const acceptMocks = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
    });
    const view5 = render(
      <Wrapper>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={acceptMocks.client} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </Wrapper>,
    );
    await waitFor(() => {
      const btn = view5.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.getAttribute("title")).toBeFalsy();
    });
    view5.unmount();
  });

  test("B: ff mode + subject, confirm summary, POST exact body once, 3 GETs, task ID, landed sha, invalidation after done", async () => {
    const { scheduler, tick, pending: pendingCount } = makeManualScheduler();
    const mocks = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
      landResponse: { ok: true, task_id: "t-land-1", status: "queued" },
      taskResponses: [
        (_id) => makeDispatchLandTask({ task_id: "t-land-1", status: "queued" }),
        (_id) => makeDispatchLandTask({ task_id: "t-land-1", status: "running" }),
        (_id) =>
          makeDispatchLandTask({
            task_id: "t-land-1",
            status: "done",
            result: {
              ok: true,
              commit_sha: "sha-landed-789",
              message_subject: "feat: test",
              branch_deleted: true,
              pr_closed: false,
              worktree_torn_down: true,
            },
          }),
      ],
      listResponse: [{ handoff_id: "h-new" } as HandoffRow],
    });

    const { Wrapper, client: queryClient } = makeWrapper();
    const fourSegKey: import("@tanstack/react-query").QueryKey = [
      "handoffs",
      "by-status",
      "pending",
      "alpha",
    ];
    queryClient.setQueryData(fourSegKey, { handoffs: [{ handoff_id: "h-old" }] });
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");

    function Observer(): JSX.Element {
      const q = useQuery({
        queryKey: handoffsByStatus("pending", "alpha"),
        queryFn: () => mocks.client.handoffs.list({ status: "pending", agent: "alpha" }),
      });
      const ids = (q.data?.handoffs ?? []).map((h) => h.handoff_id).join(",");
      return <div data-testid="observer">{ids}</div>;
    }

    const view = render(
      <Wrapper>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={mocks.client} scheduler={scheduler} />
            <Observer />
          </ConfirmDialogProvider>
        </ToastProvider>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(
        (view.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    fireEvent.click(
      view.container.querySelector('[data-testid="land-mode-ff"]') as HTMLInputElement,
    );
    typeIntoInput(
      view.container.querySelector('[data-testid="land-subject"]') as HTMLInputElement,
      "feat: land the branch",
    );
    fireEvent.click(
      view.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(getByRole(view.container, "dialog")).toBeTruthy();
    });
    const dialog = getByRole(view.container, "dialog");
    expect(dialog.textContent).toContain("ff");
    expect(dialog.textContent).toContain("feat: land the branch");

    fillConfirm(view.container, "looks good", HANDOFF_ID);

    await waitFor(() => {
      expect(mocks.land).toHaveBeenCalledTimes(1);
    });
    expect(mocks.land.mock.calls[0]![0]).toEqual({
      handoff_id: HANDOFF_ID,
      mode: "ff",
      commit_message: "feat: land the branch",
    });

    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="land-task-id"]')?.textContent).toContain(
        "t-land-1",
      );
    });

    await waitFor(() => {
      expect(mocks.task).toHaveBeenCalledTimes(1);
      expect(mocks.task.mock.calls[0]![0]).toBe("t-land-1");
    });

    const invalidateCallsBeforeTerminal = invalidateSpy.mock.calls.length;
    expect(pendingCount()).toBe(1);
    tick();
    await waitFor(() => {
      expect(mocks.task).toHaveBeenCalledTimes(2);
    });
    expect(view.container.querySelector('[data-testid="land-task-id"]')?.textContent).toContain(
      "t-land-1",
    );

    expect(pendingCount()).toBe(1);
    tick();
    await waitFor(() => {
      expect(mocks.task).toHaveBeenCalledTimes(3);
    });

    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="land-result"]')?.textContent).toContain(
        "sha-landed-789",
      );
    });
    expect(pendingCount()).toBe(0);
    expect(invalidateSpy.mock.calls.length).toBeGreaterThan(invalidateCallsBeforeTerminal);

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(
      invalidatedKeys.some(
        (k) => JSON.stringify(k) === JSON.stringify(["handoffs", "detail", HANDOFF_ID]),
      ),
    ).toBe(true);
    expect(
      invalidatedKeys.some(
        (k) => JSON.stringify(k) === JSON.stringify(["dispatch", "audit", HANDOFF_ID]),
      ),
    ).toBe(true);
    expect(
      invalidatedKeys.some(
        (k) => JSON.stringify(k) === JSON.stringify(["dispatch", "events", HANDOFF_ID]),
      ),
    ).toBe(true);
    for (const status of ["pending", "dispatched", "completed", "failed"]) {
      const matching = invalidatedKeys.filter(
        (k) => Array.isArray(k) && k[0] === "handoffs" && k[1] === "by-status" && k[2] === status,
      );
      expect(matching.length).toBeGreaterThanOrEqual(1);
      for (const k of matching) expect(k).toHaveLength(3);
    }
    expect(
      invalidatedKeys.some((k) => JSON.stringify(k) === JSON.stringify(["handoffs", "pending"])),
    ).toBe(true);
    expect(
      invalidatedKeys.some((k) => JSON.stringify(k) === JSON.stringify(["approvals", "handoffs"])),
    ).toBe(true);
    expect(
      invalidatedKeys.some((k) => JSON.stringify(k) === JSON.stringify(["chains", "dispatched"])),
    ).toBe(true);

    await waitFor(() => {
      expect(mocks.list.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    view.unmount();
    queryClient.clear();
  });

  test("C: terminal failed shows code/message and reenables Land; POST failure visible; poll failure resumes GET", async () => {
    const { scheduler, tick } = makeManualScheduler();

    // --- Terminal failed ---
    const failMocks = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
      landResponse: { ok: true, task_id: "t-fail-1", status: "queued" },
      taskResponses: [
        (_id) =>
          makeDispatchLandTask({
            task_id: "t-fail-1",
            status: "failed",
            error: { code: "merge_conflict" },
            result: null,
          }),
      ],
    });
    const { Wrapper: W1 } = makeWrapper();
    const view = render(
      <W1>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={failMocks.client} scheduler={scheduler} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </W1>,
    );

    await waitFor(() => {
      expect(
        (view.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(
      view.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(getByRole(view.container, "dialog")).toBeTruthy();
    });
    fillConfirm(view.container, "trying", HANDOFF_ID);

    await waitFor(() => {
      expect(failMocks.land).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(failMocks.task).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="land-error"]')?.textContent).toContain(
        "merge_conflict",
      );
    });
    await waitFor(() => {
      expect(
        (view.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    view.unmount();

    // --- POST failure visible ---
    const postFailMocks = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
      landThrows: new DaemonHttpError({
        status: 409,
        statusText: "Conflict",
        bodyText: '{"error":"already_landed"}',
        url: "/dispatch/land",
      }),
    });
    const { Wrapper: W2 } = makeWrapper();
    const view2 = render(
      <W2>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={postFailMocks.client} scheduler={scheduler} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </W2>,
    );

    await waitFor(() => {
      expect(
        (view2.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(
      view2.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(getByRole(view2.container, "dialog")).toBeTruthy();
    });
    fillConfirm(view2.container, "retry", HANDOFF_ID);

    await waitFor(() => {
      expect(view2.container.querySelector('[data-testid="land-error"]')?.textContent).toContain(
        "already_landed",
      );
    });
    await waitFor(() => {
      expect(
        (view2.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    view2.unmount();

    // --- Poll HTTP failure: retain task ID, resume GET (not POST) ---
    const pollFailMocks = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
      landResponse: { ok: true, task_id: "t-poll-1", status: "queued" },
      taskResponses: [
        (): DispatchLandTask => {
          throw new DaemonHttpError({
            status: 503,
            statusText: "Service Unavailable",
            bodyText: '{"error":"server_busy"}',
            url: "/dispatch/land/t-poll-1",
          });
        },
        (id: string) => makeDispatchLandTask({ task_id: id, status: "done" }),
      ],
    });
    const { Wrapper: W3 } = makeWrapper();
    const view3 = render(
      <W3>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={pollFailMocks.client} scheduler={scheduler} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </W3>,
    );

    await waitFor(() => {
      expect(
        (view3.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(
      view3.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(getByRole(view3.container, "dialog")).toBeTruthy();
    });
    fillConfirm(view3.container, "go", HANDOFF_ID);

    await waitFor(() => {
      expect(pollFailMocks.land).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(view3.container.querySelector('[data-testid="land-task-id"]')?.textContent).toContain(
        "t-poll-1",
      );
    });
    await waitFor(() => {
      expect(view3.container.querySelector('[data-testid="land-error"]')?.textContent).toContain(
        "server_busy",
      );
    });
    expect(view3.container.querySelector('[data-testid="land-task-id"]')?.textContent).toContain(
      "t-poll-1",
    );
    await waitFor(() => {
      expect(
        (view3.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });

    const retryBtn = view3.container.querySelector('[data-testid="land-retry"]');
    expect(retryBtn).toBeTruthy();
    fireEvent.click(retryBtn!);
    await waitFor(() => {
      expect(pollFailMocks.task.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(pollFailMocks.land).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(view3.container.querySelector('[data-testid="land-result"]')?.textContent).toContain(
        "abc123def456",
      );
    });
    view3.unmount();
  });
});
