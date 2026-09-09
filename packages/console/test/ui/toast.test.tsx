import "../setup";
import { getByRole } from "@testing-library/dom";
import { act, cleanup, fireEvent, render, renderHook, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import { ToastProvider, useToast } from "@src/ui/Toast";

afterEach(cleanup);

describe("Toast", () => {
  test("useToast pushes into the status region", () => {
    const { result } = renderHook(() => useToast(), {
      wrapper: ({ children }) => <ToastProvider>{children}</ToastProvider>,
    });

    act(() => {
      result.current.push({ kind: "error", text: "handoff_conflict" });
    });

    const status = getByRole(document.body, "status");
    expect(status.textContent).toContain("handoff_conflict");
  });

  test("Dismiss removes the toast", () => {
    const { result } = renderHook(() => useToast(), {
      wrapper: ({ children }) => <ToastProvider>{children}</ToastProvider>,
    });

    act(() => {
      result.current.push({ kind: "info", text: "chain started" });
    });

    const status = getByRole(document.body, "status");
    expect(status.textContent).toContain("chain started");

    const dismissBtn = within(status).getByLabelText("Dismiss");
    fireEvent.click(dismissBtn);

    expect(getByRole(document.body, "status").textContent).toBe("");
  });

  test("useToast() returns the same api object across ToastProvider re-renders", () => {
    const seen: ReturnType<typeof useToast>[] = [];
    function Probe(): JSX.Element | null {
      const toast = useToast();
      seen.push(toast);
      return null;
    }

    const { rerender } = render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );

    const first = seen[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("no api recorded");
    act(() => {
      first.push({ kind: "info", text: "x" });
    });

    act(() => {
      rerender(
        <ToastProvider>
          <Probe />
        </ToastProvider>,
      );
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const api of seen) {
      expect(api).toBe(first);
    }
  });

  test("a consumer effect keyed on useToast() pushes exactly one toast", () => {
    function Toaster(): JSX.Element | null {
      const toast = useToast();
      useEffect(() => {
        toast.push({ kind: "info", text: "once" });
      }, [toast]);
      return null;
    }

    render(
      <ToastProvider>
        <Toaster />
      </ToastProvider>,
    );

    const status = getByRole(document.body, "status");
    expect(status.querySelectorAll(".toast").length).toBe(1);
  });
});
