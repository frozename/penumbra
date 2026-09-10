import "../../setup";
import type { CloseLaneRequest, LaneRow } from "@penumbra/api-contract";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { DaemonClient } from "@src/api/client";
import { DaemonHttpError } from "@src/api/errors";
import { __resetBrokerForTests, __setSourceFactory } from "@src/api/streams";
import { lanesRecent } from "@src/lib/query-keys";
import { HandoffsView } from "@src/modules/handoffs";
import { LaneCloseForm } from "@src/modules/handoffs/LaneCloseForm";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

const row: LaneRow = {
  lane_id: "lane-full-id",
  ts_opened: "2026-09-10T10:00:00Z",
  ts_closed: null,
  task_class: "STANDARD",
  implementer_handoff: "implementer-full-id",
  reviewer_handoff: null,
  gate_status: "open",
  recalled_memory_ids: [],
  recalled_query: null,
  override_reason: null,
  metadata_json: "{}",
};
let rows: LaneRow[];
let close = mock(
  (body: CloseLaneRequest): Promise<LaneRow> =>
    Promise.resolve({ ...row, ...body, ts_closed: "2026-09-10T11:00:00Z" }),
);
beforeEach(() => {
  rows = [{ ...row }];
  close = mock((body: CloseLaneRequest) => {
    const result = { ...row, ...body, ts_closed: "2026-09-10T11:00:00Z" };
    rows = [result];
    return Promise.resolve(result);
  });
  useUIStore.setState({ activeModule: "handoffs" });
  useDaemonStore.setState({
    baseUrl: "http://daemon.test",
    token: "test",
    health: "ok",
    sessionInvalid: false,
  });
  __resetBrokerForTests();
  __setSourceFactory(() => ({ addEventListener() {}, close() {} }));
});
afterEach(() => {
  cleanup();
  __setSourceFactory(null);
  __resetBrokerForTests();
});
function setup(form = false) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  const recent = mock(() => Promise.resolve({ lanes: rows }));
  const list = mock((_query?: { status?: string; agent?: string }) =>
    Promise.resolve({ handoffs: [] }),
  );
  const client = { lanes: { recent, close }, handoffs: { list } } as unknown as DaemonClient;
  function tree(lane: LaneRow | undefined) {
    return (
      <QueryClientProvider client={cache}>
        <ToastProvider>
          <ConfirmDialogProvider>
            <MemoryRouter>
              {form ? (
                lane && <LaneCloseForm key={lane.lane_id} lane={lane} client={client} />
              ) : (
                <HandoffsView client={client} />
              )}
            </MemoryRouter>
          </ConfirmDialogProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  const view = render(tree(row));
  return { ...view, cache, recent, list, client, tree };
}
function type(input: HTMLElement, value: string) {
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "a" });
  fireEvent.input(input, { target: { value } });
  fireEvent.keyUp(input, { key: "a" });
}
async function confirm(view: ReturnType<typeof setup>) {
  await waitFor(() => {
    expect(view.getByRole("dialog")).toBeTruthy();
  });
  type(view.getByLabelText("Reason"), "reviewed");
  type(view.getByLabelText("Confirmation target"), row.lane_id);
  fireEvent.click(view.getByRole("button", { name: "Confirm" }));
}

test("the handoffs module mounts Lanes, hides agent filtering, and stops handoff reads", async () => {
  const v = setup();
  await waitFor(() => {
    expect(v.list).toHaveBeenCalledTimes(1);
  });
  expect(v.getAllByRole("tab").map((t) => t.textContent)).toEqual([
    "Pending",
    "Dispatched",
    "Completed",
    "Failed",
    "Lanes",
  ]);
  fireEvent.click(v.getByRole("tab", { name: "Lanes" }));
  await waitFor(() => {
    expect(v.recent).toHaveBeenCalledTimes(1);
  });
  expect(v.queryByLabelText("Agent filter")).toBeNull();
  expect(v.getByRole("link", { name: row.implementer_handoff }).getAttribute("href")).toBe(
    `/handoffs/${row.implementer_handoff}`,
  );
  expect(v.getByText(row.lane_id).closest("a")).toBeNull();
  expect(v.queryByRole("button", { name: /Open lane/i })).toBeNull();
  await act(async () => {
    await v.cache.invalidateQueries({ queryKey: ["handoffs", "by-status"] });
  });
  expect(v.list).toHaveBeenCalledTimes(1);
  fireEvent.click(v.getByRole("button", { name: `Close lane ${row.lane_id}` }));
  expect(v.getByLabelText("Gate status")).toBeTruthy();
  fireEvent.click(v.getByRole("tab", { name: "Failed" }));
  await waitFor(() => {
    expect(v.list).toHaveBeenCalledTimes(2);
  });
  expect(v.list.mock.calls[1]?.[0]).toEqual({ status: "failed", agent: undefined });
});
test("gate status, reason and exact target guard the captured close body and refresh lanes", async () => {
  const v = setup();
  fireEvent.click(v.getByRole("tab", { name: "Lanes" }));
  await waitFor(() => {
    expect(v.getByRole("button", { name: `Close lane ${row.lane_id}` })).toBeTruthy();
  });
  fireEvent.click(v.getByRole("button", { name: `Close lane ${row.lane_id}` }));
  const submit = v.getByTestId("lane-close-submit") as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(v.getByLabelText("Gate status"), { target: { value: "passed" } });
  type(v.getByLabelText("Reviewer handoff"), " reviewer-full-id ");
  type(v.getByLabelText("Notes"), " review notes ");
  fireEvent.click(submit);
  await waitFor(() => {
    expect(v.getByRole("dialog")).toBeTruthy();
  });
  expect(v.getByRole("dialog").textContent).toContain("reviewer-full-id");
  expect((v.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
  type(v.getByLabelText("Reason"), "reviewed");
  type(v.getByLabelText("Confirmation target"), "wrong");
  expect((v.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
  expect(close).toHaveBeenCalledTimes(0);
  type(v.getByLabelText("Confirmation target"), row.lane_id);
  fireEvent.click(v.getByRole("button", { name: "Confirm" }));
  await waitFor(() => {
    expect(close).toHaveBeenCalledTimes(1);
  });
  expect(close.mock.calls[0]?.[0]).toEqual({
    lane_id: row.lane_id,
    gate_status: "passed",
    reviewer_handoff: "reviewer-full-id",
    metadata: { notes: "review notes" },
  });
  await waitFor(() => {
    expect(v.queryByRole("button", { name: `Close lane ${row.lane_id}` })).toBeNull();
  });
  expect(v.recent.mock.calls.length).toBeGreaterThan(1);
});
test("blank optional fields are omitted and cancelling allows another attempt", async () => {
  const v = setup(true);
  fireEvent.change(v.getByLabelText("Gate status"), { target: { value: "skipped" } });
  fireEvent.click(v.getByTestId("lane-close-submit"));
  await waitFor(() => {
    expect(v.getByRole("dialog")).toBeTruthy();
  });
  fireEvent.click(v.getAllByRole("button", { name: "Cancel" }).at(-1)!);
  await waitFor(() => {
    expect((v.getByTestId("lane-close-submit") as HTMLButtonElement).disabled).toBe(false);
  });
  expect(close).toHaveBeenCalledTimes(0);
  fireEvent.click(v.getByTestId("lane-close-submit"));
  await confirm(v);
  await waitFor(() => {
    expect(close).toHaveBeenCalledTimes(1);
  });
  expect(close.mock.calls[0]?.[0]).toEqual({ lane_id: row.lane_id, gate_status: "skipped" });
});
for (const [status, code] of [
  [400, "same_agent_self_review"],
  [409, "lane_already_closed"],
] as const) {
  test(`close ${status} ${code} stays inline and allows retry`, async () => {
    close.mockImplementation(() =>
      Promise.reject(
        new DaemonHttpError({
          status,
          statusText: "error",
          bodyText: JSON.stringify({ error: { code } }),
          url: "/lanes/close",
        }),
      ),
    );
    const v = setup(true);
    fireEvent.change(v.getByLabelText("Gate status"), { target: { value: "failed" } });
    fireEvent.click(v.getByTestId("lane-close-submit"));
    await confirm(v);
    await waitFor(() => {
      expect(v.getByTestId("lane-close-error").textContent).toContain(code);
    });
    expect((v.getByTestId("lane-close-submit") as HTMLButtonElement).disabled).toBe(false);
    expect(v.getByLabelText("Gate status")).toBeTruthy();
  });
}
for (const mode of ["unmount", "replace", "closed"] as const) {
  test(`a ${mode} lane cannot be closed by its stale confirmation`, async () => {
    const v = setup(true);
    fireEvent.change(v.getByLabelText("Gate status"), { target: { value: "skipped" } });
    fireEvent.click(v.getByTestId("lane-close-submit"));
    await waitFor(() => {
      expect(v.getByRole("dialog")).toBeTruthy();
    });
    v.rerender(
      v.tree(
        mode === "unmount"
          ? undefined
          : mode === "replace"
            ? { ...row, lane_id: "different-lane" }
            : { ...row, gate_status: "passed" },
      ),
    );
    await confirm(v);
    await act(async () => {
      await Promise.resolve();
    });
    expect(close).toHaveBeenCalledTimes(0);
  });
}
test("an external lane close removes its selected form", async () => {
  const v = setup();
  fireEvent.click(v.getByRole("tab", { name: "Lanes" }));
  await waitFor(() => {
    expect(v.getByRole("button", { name: `Close lane ${row.lane_id}` })).toBeTruthy();
  });
  fireEvent.click(v.getByRole("button", { name: `Close lane ${row.lane_id}` }));
  await act(async () => {
    v.cache.setQueryData(lanesRecent(), { lanes: [{ ...row, gate_status: "passed" }] });
  });
  await waitFor(() => {
    expect(v.queryByLabelText("Gate status") === null).toBe(true);
  });
});
