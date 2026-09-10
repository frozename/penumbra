import "../../setup";

import { getByLabelText, getByRole } from "@testing-library/dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { DaemonHttpError } from "@src/api/errors";
import { makeDispatchAuditResponse } from "@src/modules/handoffs/fixtures";
import { LandPanel } from "@src/modules/handoffs/LandPanel";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";

import {
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

describe("LandPanel (fail + lifecycle)", () => {
  test("D: Fail guarded — blank reason/wrong target blocked, exact fail call, no Complete, failed Fail keeps page", async () => {
    const mocks = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
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
      expect(
        (view.container.querySelector('[data-testid="fail-button"]') as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    const allButtons = view.container.querySelectorAll("button");
    const labels = Array.from(allButtons).map((b) => b.textContent ?? "");
    expect(labels).not.toContain("Complete");

    fireEvent.click(
      view.container.querySelector('[data-testid="fail-button"]') as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(getByRole(view.container, "dialog")).toBeTruthy();
    });

    const dialog = getByRole(view.container, "dialog");
    let confirmBtn = getByRole(dialog, "button", {
      name: "Confirm",
    }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.click(confirmBtn);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.fail).not.toHaveBeenCalled();

    const reasonField = getByLabelText(view.container, "Reason") as HTMLTextAreaElement;
    typeIntoInput(reasonField, "typed reason");
    let targetField = getByLabelText(view.container, "Confirmation target") as HTMLInputElement;
    typeIntoInput(targetField, "wrong-id");
    await waitFor(() => {
      confirmBtn = getByRole(dialog, "button", { name: "Confirm" }) as HTMLButtonElement;
      expect(confirmBtn.disabled).toBe(true);
    });

    targetField = getByLabelText(view.container, "Confirmation target") as HTMLInputElement;
    typeIntoInput(targetField, HANDOFF_ID);
    await waitFor(() => {
      confirmBtn = getByRole(dialog, "button", { name: "Confirm" }) as HTMLButtonElement;
      expect(confirmBtn.disabled).toBe(false);
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mocks.fail).toHaveBeenCalledTimes(1);
    });
    expect(mocks.fail.mock.calls[0]![0]).toBe(HANDOFF_ID);
    expect(mocks.fail.mock.calls[0]![1]).toEqual({ reason: "typed reason" });

    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="land-button"]')).toBeTruthy();
    });
    view.unmount();

    // --- Failed Fail leaves page visible and no success invalidation ---
    const failErrMocks = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
      failThrows: new DaemonHttpError({
        status: 500,
        statusText: "Internal Server Error",
        bodyText: '{"error":"server_error"}',
        url: "/handoffs/h-abc12345/fail",
      }),
    });
    const { Wrapper: WErr, client: qcErr } = makeWrapper();
    const invalidateSpy = spyOn(qcErr, "invalidateQueries");
    const view2 = render(
      <WErr>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={failErrMocks.client} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </WErr>,
    );

    await waitFor(() => {
      expect(
        (view2.container.querySelector('[data-testid="fail-button"]') as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(
      view2.container.querySelector('[data-testid="fail-button"]') as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(getByRole(view2.container, "dialog")).toBeTruthy();
    });
    fillConfirm(view2.container, "failing it", HANDOFF_ID);

    await waitFor(() => {
      expect(failErrMocks.fail).toHaveBeenCalledTimes(1);
    });
    expect(view2.container.querySelector('[data-testid="land-button"]')).toBeTruthy();
    expect(view2.container.querySelector('[data-testid="fail-button"]')).toBeTruthy();
    expect(invalidateSpy).not.toHaveBeenCalled();

    view2.unmount();
    qcErr.clear();
  });

  test("E: blank subject omits commit_message entirely and typed subject verbatim; default mode is squash", async () => {
    // --- Blank subject → omit commit_message ---
    const mocks = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
      landResponse: { ok: true, task_id: "t-blank", status: "queued" },
      taskResponses: [(id) => makeDispatchLandTask({ task_id: id, status: "done" })],
    });
    const { scheduler, tick } = makeManualScheduler();
    const { Wrapper } = makeWrapper();
    const view = render(
      <Wrapper>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={mocks.client} scheduler={scheduler} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(
        (view.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    const squashRadio = view.container.querySelector(
      '[data-testid="land-mode-squash"]',
    ) as HTMLInputElement;
    const ffRadio = view.container.querySelector(
      '[data-testid="land-mode-ff"]',
    ) as HTMLInputElement;
    expect(squashRadio.checked).toBe(true);
    expect(ffRadio.checked).toBe(false);

    fireEvent.click(
      view.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(getByRole(view.container, "dialog")).toBeTruthy();
    });
    fillConfirm(view.container, "blank subject", HANDOFF_ID);

    await waitFor(() => {
      expect(mocks.land).toHaveBeenCalledTimes(1);
    });
    expect(mocks.land.mock.calls[0]![0]).toEqual({
      handoff_id: HANDOFF_ID,
      mode: "squash",
    });
    expect(mocks.land.mock.calls[0]![0]).not.toHaveProperty("commit_message");

    await waitFor(() => {
      expect(mocks.task).toHaveBeenCalledTimes(1);
    });
    tick();
    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="land-result"]')).toBeTruthy();
    });
    view.unmount();

    // --- Whitespace-only subject also omits ---
    const mocks2 = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
      landResponse: { ok: true, task_id: "t-ws", status: "queued" },
      taskResponses: [(id) => makeDispatchLandTask({ task_id: id, status: "done" })],
    });
    const { scheduler: s2, tick: t2 } = makeManualScheduler();
    const { Wrapper: W2 } = makeWrapper();
    const view2 = render(
      <W2>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={mocks2.client} scheduler={s2} />
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
    typeIntoInput(
      view2.container.querySelector('[data-testid="land-subject"]') as HTMLInputElement,
      "   ",
    );
    fireEvent.click(
      view2.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(getByRole(view2.container, "dialog")).toBeTruthy();
    });
    fillConfirm(view2.container, "ws subject", HANDOFF_ID);

    await waitFor(() => {
      expect(mocks2.land).toHaveBeenCalledTimes(1);
    });
    expect(mocks2.land.mock.calls[0]![0]).toEqual({
      handoff_id: HANDOFF_ID,
      mode: "squash",
    });
    expect(mocks2.land.mock.calls[0]![0]).not.toHaveProperty("commit_message");

    await waitFor(() => {
      expect(mocks2.task).toHaveBeenCalledTimes(1);
    });
    t2();
    await waitFor(() => {
      expect(view2.container.querySelector('[data-testid="land-result"]')).toBeTruthy();
    });
    view2.unmount();

    // --- Typed non-blank subject sent verbatim ---
    const mocks3 = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
      landResponse: { ok: true, task_id: "t-typed", status: "queued" },
      taskResponses: [(id) => makeDispatchLandTask({ task_id: id, status: "done" })],
    });
    const { scheduler: s3, tick: t3 } = makeManualScheduler();
    const { Wrapper: W3 } = makeWrapper();
    const view3 = render(
      <W3>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={mocks3.client} scheduler={s3} />
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
    typeIntoInput(
      view3.container.querySelector('[data-testid="land-subject"]') as HTMLInputElement,
      "fix: exact subject  ",
    );
    fireEvent.click(
      view3.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(getByRole(view3.container, "dialog")).toBeTruthy();
    });
    fillConfirm(view3.container, "typed", HANDOFF_ID);

    await waitFor(() => {
      expect(mocks3.land).toHaveBeenCalledTimes(1);
    });
    expect(mocks3.land.mock.calls[0]![0]).toEqual({
      handoff_id: HANDOFF_ID,
      mode: "squash",
      commit_message: "fix: exact subject  ",
    });

    await waitFor(() => {
      expect(mocks3.task).toHaveBeenCalledTimes(1);
    });
    t3();
    await waitFor(() => {
      expect(view3.container.querySelector('[data-testid="land-result"]')).toBeTruthy();
    });
    view3.unmount();
  });

  test("F: unmount and route change stop further polls, no stale old ID result in new panel", async () => {
    const { scheduler, tick, pending: pendingCount } = makeManualScheduler();
    const mocks = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
      landResponse: { ok: true, task_id: "t-old-1", status: "queued" },
      taskResponses: [(id) => makeDispatchLandTask({ task_id: id, status: "queued" })],
    });
    const { Wrapper } = makeWrapper();
    const view = render(
      <Wrapper>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel handoffId={HANDOFF_ID} client={mocks.client} scheduler={scheduler} />
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
      view.container.querySelector('[data-testid="land-button"]') as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(getByRole(view.container, "dialog")).toBeTruthy();
    });
    fillConfirm(view.container, "land it", HANDOFF_ID);

    await waitFor(() => {
      expect(mocks.land).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="land-task-id"]')?.textContent).toContain(
        "t-old-1",
      );
    });
    await waitFor(() => {
      expect(mocks.task).toHaveBeenCalledTimes(1);
    });
    expect(pendingCount()).toBe(1);

    view.unmount();
    tick();
    expect(mocks.task.mock.calls.length).toBe(1);

    // --- Route change (new handoffId) stops old polling ---
    const { scheduler: s2 } = makeManualScheduler();
    const mocks2 = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
      }),
      landResponse: { ok: true, task_id: "t-route-1", status: "queued" },
      taskResponses: [(id) => makeDispatchLandTask({ task_id: id, status: "queued" })],
    });
    const { Wrapper: W2 } = makeWrapper();
    const key = "route-key";
    const view2 = render(
      <W2>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel key={key} handoffId={HANDOFF_ID} client={mocks2.client} scheduler={s2} />
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
    fillConfirm(view2.container, "land it 2", HANDOFF_ID);

    await waitFor(() => {
      expect(mocks2.land).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(view2.container.querySelector('[data-testid="land-task-id"]')?.textContent).toContain(
        "t-route-1",
      );
    });
    await waitFor(() => {
      expect(mocks2.task).toHaveBeenCalledTimes(1);
    });

    const NEW_HANDOFF_ID = "h-new12345";
    const mocks3 = makeClient({
      auditResponse: makeDispatchAuditResponse({
        status: "complete",
        recommended_action: "accept",
        handoff_id: NEW_HANDOFF_ID,
      }),
    });
    view2.rerender(
      <W2>
        <ToastProvider>
          <ConfirmDialogProvider>
            <LandPanel key={key} handoffId={NEW_HANDOFF_ID} client={mocks3.client} scheduler={s2} />
          </ConfirmDialogProvider>
        </ToastProvider>
      </W2>,
    );

    await waitFor(() => {
      const taskIdEl = view2.container.querySelector('[data-testid="land-task-id"]');
      if (taskIdEl) {
        expect(taskIdEl.textContent).not.toContain("t-route-1");
      }
    });

    const oldTaskCalls = mocks2.task.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks2.task.mock.calls.length).toBe(oldTaskCalls);

    view2.unmount();
  });
});
