import "../setup";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getByLabelText, getByRole } from "@testing-library/dom";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { DaemonClient } from "@src/api/client";
import { DaemonHttpError } from "@src/api/errors";
import {
  ActionTierUnavailable,
  type DaemonActionSpec,
  useDaemonAction,
} from "@src/hooks/useDaemonAction";
import { useDaemonStore } from "@src/stores/daemon-store";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

interface Args {
  id: string;
}

type RunCall = [DaemonClient, Args, { reason?: string; signal: AbortSignal }];

function makeWrapper(): {
  Wrapper: (p: { children: ReactNode }) => ReactNode;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, client };
}

function makeSpec(
  run: ReturnType<typeof mock>,
  opts?: Partial<DaemonActionSpec<Args, { ok: true }>>,
): DaemonActionSpec<Args, { ok: true }> {
  return {
    id: "test-action",
    tier: "safe",
    label: "Test action",
    run: run,
    invalidate: (_args, _result) => [
      ["handoffs", "pending"],
      ["registrar", "list"],
    ],
    ...opts,
  };
}

function typeIntoField(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  fireEvent.focus(field);
  fireEvent.keyDown(field, { key: value.slice(-1) || "x" });
  fireEvent.input(field, { target: { value } });
  fireEvent.keyUp(field, { key: value.slice(-1) || "x" });
}

beforeEach(() => {
  useDaemonStore.setState({
    baseUrl: "http://127.0.0.1:51257",
    token: "t",
    bootError: null,
    health: "unknown",
    lastHealthAt: null,
    sessionInvalid: false,
  });
});

afterEach(() => {
  cleanup();
  useDaemonStore.setState({
    baseUrl: "http://127.0.0.1:51257",
    token: "t",
    bootError: null,
    health: "unknown",
    lastHealthAt: null,
    sessionInvalid: false,
  });
});

describe("useDaemonAction", () => {
  test("safe: run called once; invalidateQueries once per key from invalidate(args, result)", async () => {
    const { Wrapper, client } = makeWrapper();
    const spy = spyOn(client, "invalidateQueries");
    const fakeClient = {} as DaemonClient;
    const run = mock(async () => ({ ok: true as const }));
    const spec = makeSpec(run);

    const { result } = renderHook(() => useDaemonAction(spec, { client: fakeClient }), {
      wrapper: Wrapper,
    });

    await act(async () => {
      const res = await result.current.execute({ id: "h1" });
      expect(res).toEqual({ ok: true });
    });

    expect(run).toHaveBeenCalledTimes(1);
    const callArgs = (run.mock.calls as unknown as RunCall[])[0]!;
    expect(callArgs[0]).toBe(fakeClient);
    expect(callArgs[1]).toEqual({ id: "h1" });
    expect(callArgs[2].signal).toBeInstanceOf(AbortSignal);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0]).toEqual({ queryKey: ["handoffs", "pending"] });
    expect(spy.mock.calls[1]![0]).toEqual({ queryKey: ["registrar", "list"] });
  });

  test("guarded: run not called until Confirm with a non-space reason; ctx.reason carries it", async () => {
    const { Wrapper, client } = makeWrapper();
    spyOn(client, "invalidateQueries");
    const fakeClient = {} as DaemonClient;
    const run = mock(async () => ({ ok: true as const }));
    const spec = makeSpec(run, { tier: "guarded", confirm: { title: "Approve" } });

    const { result } = renderHook(() => useDaemonAction(spec, { client: fakeClient }), {
      wrapper: Wrapper,
    });

    expect(run).not.toHaveBeenCalled();

    let execPromise!: Promise<unknown>;
    act(() => {
      execPromise = result.current.execute({ id: "h2" });
    });

    const dialog = getByRole(document.body, "dialog");
    expect(dialog).toBeTruthy();

    const reasonField = getByLabelText(document.body, "Reason") as HTMLTextAreaElement;
    act(() => {
      typeIntoField(reasonField, "because");
    });

    const confirmBtn = dialog.querySelector("button.btn-primary") as HTMLButtonElement;
    act(() => {
      fireEvent.click(confirmBtn);
    });

    await act(async () => {
      await execPromise;
    });

    expect(run).toHaveBeenCalledTimes(1);
    const guardedCalls = run.mock.calls as unknown as RunCall[];
    expect(guardedCalls[0]![2].reason).toBe("because");
  });

  test("a DaemonHttpError with a code renders a toast containing the code", async () => {
    const { Wrapper } = makeWrapper();
    const fakeClient = {} as DaemonClient;
    const run = mock(async () => {
      throw new DaemonHttpError({
        status: 409,
        statusText: "Conflict",
        bodyText: JSON.stringify({ error: { code: "handoff_conflict" } }),
        url: "http://x/handoffs/h1/approve",
      });
    });
    const spec = makeSpec(run);

    const { result } = renderHook(() => useDaemonAction(spec, { client: fakeClient }), {
      wrapper: Wrapper,
    });

    let resolved: unknown = "not-resolved";
    await act(async () => {
      resolved = await result.current.execute({ id: "h3" });
    });

    expect(resolved).toBeUndefined();
    const status = getByRole(document.body, "status");
    expect(status.textContent ?? "").toContain("handoff_conflict");
    expect(result.current.lastError?.code).toBe("handoff_conflict");
  });

  test("401 invalid_session sets daemon-store.sessionInvalid and emits no toast", async () => {
    const { Wrapper } = makeWrapper();
    const fakeClient = {} as DaemonClient;
    const run = mock(async () => {
      throw new DaemonHttpError({
        status: 401,
        statusText: "Unauthorized",
        bodyText: '{"error":"invalid_session"}',
        url: "http://x/handoffs",
      });
    });
    const spec = makeSpec(run);

    const { result } = renderHook(() => useDaemonAction(spec, { client: fakeClient }), {
      wrapper: Wrapper,
    });

    await act(async () => {
      const res = await result.current.execute({ id: "h4" });
      expect(res).toBeUndefined();
    });

    expect(useDaemonStore.getState().sessionInvalid).toBe(true);
    const statusRegion = document.body.querySelector('[role="status"]');
    expect(statusRegion?.textContent ?? "").toBe("");
  });

  test("401 with code 'unauthorized' does not set sessionInvalid on the write path", async () => {
    const { Wrapper } = makeWrapper();
    const fakeClient = {} as DaemonClient;
    const run = mock(async () => {
      throw new DaemonHttpError({
        status: 401,
        statusText: "Unauthorized",
        bodyText: JSON.stringify({ error: { code: "unauthorized" } }),
        url: "http://x/handoffs",
      });
    });
    const spec = makeSpec(run);

    const { result } = renderHook(() => useDaemonAction(spec, { client: fakeClient }), {
      wrapper: Wrapper,
    });

    await act(async () => {
      const res = await result.current.execute({ id: "h5" });
      expect(res).toBeUndefined();
    });

    expect(useDaemonStore.getState().sessionInvalid).toBe(false);
    const statusRegion = document.body.querySelector('[role="status"]');
    expect(statusRegion?.textContent ?? "").toContain("unauthorized");
  });

  test("tier 'destructive' throws ActionTierUnavailable at hook construction", () => {
    const { Wrapper } = makeWrapper();
    const fakeClient = {} as DaemonClient;
    const run = mock(async () => ({ ok: true as const }));
    const spec = makeSpec(run, { tier: "destructive" });

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      renderHook(() => useDaemonAction(spec, { client: fakeClient }), { wrapper: Wrapper }),
    ).toThrow(ActionTierUnavailable);
    errorSpy.mockRestore();
  });
});
