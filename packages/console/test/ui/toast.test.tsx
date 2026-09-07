import "../setup";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, renderHook, within } from "@testing-library/react";
import { getByRole } from "@testing-library/dom";
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

    const dismissBtn = within(status).getByLabelText("Dismiss") as HTMLButtonElement;
    fireEvent.click(dismissBtn);

    expect(getByRole(document.body, "status").textContent).toBe("");
  });
});
