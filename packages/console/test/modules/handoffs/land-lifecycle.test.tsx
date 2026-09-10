import "../../setup";
import type { DispatchLandAccepted } from "@penumbra/api-contract";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { DaemonClient } from "@src/api/client";
import { DaemonHttpError } from "@src/api/errors";
import { dispatchAudit } from "@src/lib/query-keys";
import { makeDispatchAuditResponse } from "@src/modules/handoffs/fixtures";
import { LandPanel } from "@src/modules/handoffs/LandPanel";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

const ID = "handoff-lifecycle-original";
const clients: QueryClient[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

function setup(): {
  client: DaemonClient;
  cache: QueryClient;
  land: ReturnType<typeof mock<DaemonClient["dispatchLand"]["land"]>>;
  task: ReturnType<typeof mock<DaemonClient["dispatchLand"]["task"]>>;
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
} {
  const land = mock<DaemonClient["dispatchLand"]["land"]>(async () => ({
    ok: true,
    task_id: "accepted-task-original",
    status: "queued",
  }));
  const task = mock<DaemonClient["dispatchLand"]["task"]>(async () => {
    throw new DaemonHttpError({
      status: 503,
      url: "/dispatch/land/accepted-task-original",
      statusText: "Unavailable",
      bodyText: JSON.stringify({ error: { code: "status_unavailable" } }),
    });
  });
  const client = {
    dispatchAudit: {
      audit: async () =>
        makeDispatchAuditResponse({ handoff_id: ID, recommended_action: "accept" }),
    },
    dispatchLand: { land, task },
    handoffs: { fail: async (id: string) => ({ handoff_id: id, status: "failed" }) },
  } as unknown as DaemonClient;
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(cache);
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <QueryClientProvider client={cache}>
        <ToastProvider>
          <ConfirmDialogProvider>
            <MemoryRouter>{children}</MemoryRouter>
          </ConfirmDialogProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  return { client, cache, land, task, Wrapper };
}

function typeText(element: HTMLElement, value: string): void {
  fireEvent.focus(element);
  fireEvent.keyDown(element, { key: "x" });
  fireEvent.input(element, { target: { value } });
  fireEvent.keyUp(element, { key: "x" });
}

function confirm(view: ReturnType<typeof render>): void {
  typeText(view.getByLabelText("Reason"), "Lifecycle regression check");
  typeText(view.getByLabelText("Confirmation target"), ID);
  const button = view.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
}

test("an accepted task with a failed status read blocks another Land and conflicting Fail", async () => {
  const { client, land, task, Wrapper } = setup();
  const view = render(
    <Wrapper>
      <LandPanel handoffId={ID} client={client} />
    </Wrapper>,
  );
  const button = view.getByRole("button", { name: "Land" }) as HTMLButtonElement;
  await waitFor(() => {
    expect(button.disabled).toBe(false);
  });
  fireEvent.click(button);
  confirm(view);
  await waitFor(() => {
    expect(view.getByTestId("land-error").textContent).toContain("status_unavailable");
  });
  expect(land).toHaveBeenCalledTimes(1);
  expect(task).toHaveBeenCalledWith("accepted-task-original");
  expect(button.disabled).toBe(true);
  expect((view.getByRole("button", { name: "Fail" }) as HTMLButtonElement).disabled).toBe(true);
});

test("an audit refetch error fails closed even when cached data recommends accept", async () => {
  const { client, cache, Wrapper } = setup();
  cache.setQueryData(
    dispatchAudit(ID),
    makeDispatchAuditResponse({ recommended_action: "accept" }),
  );
  client.dispatchAudit.audit = async () => {
    throw new Error("audit unavailable");
  };
  const view = render(
    <Wrapper>
      <LandPanel handoffId={ID} client={client} />
    </Wrapper>,
  );
  await waitFor(() => {
    expect(cache.getQueryState(dispatchAudit(ID))?.status).toBe("error");
  });
  expect((view.getByRole("button", { name: "Land" }) as HTMLButtonElement).disabled).toBe(true);
});

test("confirming a dialog after its panel unmounts cannot submit Land", async () => {
  const { client, land, Wrapper } = setup();
  const view = render(
    <Wrapper>
      <LandPanel handoffId={ID} client={client} />
    </Wrapper>,
  );
  const button = view.getByRole("button", { name: "Land" }) as HTMLButtonElement;
  await waitFor(() => {
    expect(button.disabled).toBe(false);
  });
  fireEvent.click(button);
  expect(view.getByRole("dialog")).toBeTruthy();
  view.rerender(
    <Wrapper>
      <div>Another route</div>
    </Wrapper>,
  );
  confirm(view);
  await act(async () => {
    await Promise.resolve();
  });
  expect(land).toHaveBeenCalledTimes(0);
});

test("an old POST resolving after the handoff changes cannot start an old-task poll", async () => {
  const { client, land, task, Wrapper } = setup();
  let resolvePost: (accepted: DispatchLandAccepted) => void = () => {
    throw new Error("missing resolver");
  };
  land.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
  );
  const view = render(
    <Wrapper>
      <LandPanel handoffId={ID} client={client} />
    </Wrapper>,
  );
  const button = view.getByRole("button", { name: "Land" }) as HTMLButtonElement;
  await waitFor(() => {
    expect(button.disabled).toBe(false);
  });
  fireEvent.click(button);
  confirm(view);
  await waitFor(() => {
    expect(land).toHaveBeenCalledTimes(1);
  });
  view.rerender(
    <Wrapper>
      <LandPanel handoffId="another-handoff" client={client} />
    </Wrapper>,
  );
  await act(async () => {
    resolvePost({ ok: true, task_id: "accepted-task-original", status: "queued" });
    await Promise.resolve();
  });
  expect(task).toHaveBeenCalledTimes(0);
  expect(view.queryByTestId("land-task-id")).toBeNull();
});

test("an audit rejection while the confirmation is open prevents the POST", async () => {
  const { client, cache, land, Wrapper } = setup();
  const view = render(
    <Wrapper>
      <LandPanel handoffId={ID} client={client} />
    </Wrapper>,
  );
  const button = view.getByRole("button", { name: "Land" }) as HTMLButtonElement;
  await waitFor(() => {
    expect(button.disabled).toBe(false);
  });
  fireEvent.click(button);
  cache.setQueryData(dispatchAudit(ID), makeDispatchAuditResponse({ recommended_action: "wait" }));
  await waitFor(() => {
    expect(button.disabled).toBe(true);
  });
  confirm(view);
  await act(async () => {
    await Promise.resolve();
  });
  expect(land).toHaveBeenCalledTimes(0);
});
