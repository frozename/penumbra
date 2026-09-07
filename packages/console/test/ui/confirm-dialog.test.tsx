import "../setup";
import { getByLabelText, getByRole } from "@testing-library/dom";
import { act, cleanup, fireEvent, render, renderHook, within } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { ConfirmDialog, ConfirmDialogProvider, useConfirm } from "@src/ui/ConfirmDialog";

afterEach(cleanup);

function typeIntoField(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  fireEvent.focus(field);
  fireEvent.keyDown(field, { key: value.slice(-1) || "x" });
  fireEvent.input(field, { target: { value } });
  fireEvent.keyUp(field, { key: value.slice(-1) || "x" });
}

describe("ConfirmDialog", () => {
  test("Confirm stays disabled until the reason has a non-space character", () => {
    const onConfirm = mock((_reason: string) => {});
    const onCancel = mock(() => {});
    const { getByLabelText: getByLbl, getByText } = render(
      <ConfirmDialog open title="Approve handoff" onConfirm={onConfirm} onCancel={onCancel} />,
    );

    const reasonField = getByLbl("Reason") as HTMLTextAreaElement;
    const confirmBtn = getByText("Confirm") as HTMLButtonElement;

    expect(confirmBtn.disabled).toBe(true);

    typeIntoField(reasonField, "   ");
    expect(confirmBtn.disabled).toBe(true);

    typeIntoField(reasonField, "ok");
    expect(confirmBtn.disabled).toBe(false);

    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("ok");
  });

  test("typedTarget must match exactly", () => {
    const onConfirm = mock((_reason: string) => {});
    const onCancel = mock(() => {});
    const { getByLabelText: getByLbl, getByText } = render(
      <ConfirmDialog
        open
        title="Delete agent"
        typedTarget="agent/abc"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const reasonField = getByLbl("Reason") as HTMLTextAreaElement;
    const targetField = getByLbl("Confirmation target") as HTMLInputElement;
    const confirmBtn = getByText("Confirm") as HTMLButtonElement;

    typeIntoField(reasonField, "ok");

    typeIntoField(targetField, "agent/ab");
    expect(confirmBtn.disabled).toBe(true);

    typeIntoField(targetField, "agent/ABC");
    expect(confirmBtn.disabled).toBe(true);

    typeIntoField(targetField, "agent/abc");
    expect(confirmBtn.disabled).toBe(false);
  });

  test("useConfirm resolves with the reason on Confirm and null on Cancel", async () => {
    const { result } = renderHook(() => useConfirm(), {
      wrapper: ({ children }) => <ConfirmDialogProvider>{children}</ConfirmDialogProvider>,
    });

    let promise!: Promise<{ reason: string } | null>;
    act(() => {
      promise = result.current({ title: "Approve handoff" });
    });

    const dialog = getByRole(document.body, "dialog");
    expect(dialog).toBeTruthy();

    const reasonField = getByLabelText(document.body, "Reason") as HTMLTextAreaElement;
    typeIntoField(reasonField, "because");

    const confirmBtn = within(document.body).getByText("Confirm");
    fireEvent.click(confirmBtn);

    expect(await promise).toEqual({ reason: "because" });

    act(() => {
      promise = result.current({ title: "Approve handoff" });
    });

    const cancelBtn = within(document.body).getByText("Cancel");
    fireEvent.click(cancelBtn);

    expect(await promise).toBeNull();
  });
});
