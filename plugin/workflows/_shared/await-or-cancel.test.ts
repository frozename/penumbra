import type { WorkflowCtx } from "@penumbra/workflows";

import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { awaitChainOrCancel, cancelChainQuietly } from "./await-or-cancel.js";

type Ctx = Pick<WorkflowCtx, "awaitChain" | "cancel">;

function makeCtx(opts: {
  awaitImpl?: WorkflowCtx["awaitChain"];
  cancelImpl?: WorkflowCtx["cancel"];
}): { ctx: Ctx; cancel: ReturnType<typeof mock<WorkflowCtx["cancel"]>> } {
  const cancel = mock(opts.cancelImpl ?? ((): Promise<void> => Promise.resolve()));
  const ctx: Ctx = {
    awaitChain:
      opts.awaitImpl ??
      (() => Promise.resolve({ status: "completed", final_agent: "a", response_text: "ok" })),
    cancel,
  };
  return { ctx, cancel };
}

describe("awaitChainOrCancel", () => {
  test("omitted timeout uses 120 minutes and explicit budgets remain exact", async () => {
    const budgets: (number | undefined)[] = [];
    const { ctx, cancel } = makeCtx({
      awaitImpl: async (_id, opts) => {
        budgets.push(opts?.timeoutMs);
        return { status: "completed", final_agent: "a", response_text: "ok" };
      },
    });
    await awaitChainOrCancel(ctx, "default");
    await awaitChainOrCancel(ctx, "empty", {});
    await awaitChainOrCancel(ctx, "explicit", { timeoutMs: 1234 });
    expect(budgets).toEqual([7_200_000, 7_200_000, 1234]);
    expect(cancel).not.toHaveBeenCalled();
  });

  test("cancels a timed-out chain exactly once with its conversation_id", async () => {
    const { ctx, cancel } = makeCtx({
      awaitImpl: () =>
        Promise.resolve({ status: "timeout" as const, final_agent: null, response_text: null }),
    });

    const outcome = await awaitChainOrCancel(ctx, "conv-timeout", { timeoutMs: 5 });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("conv-timeout");
    expect(outcome.wait?.status).toBe("timeout");
    expect(outcome.cancel_requested).toBe(true);
    expect(outcome.cancel_error).toBeUndefined();
    expect(outcome.error).toBeNull();
  });

  test("does not cancel a chain that completed on its own", async () => {
    const { ctx, cancel } = makeCtx({
      awaitImpl: () =>
        Promise.resolve({
          status: "completed" as const,
          final_agent: "agent",
          response_text: "done",
        }),
    });

    const outcome = await awaitChainOrCancel(ctx, "conv-done", { timeoutMs: 5 });

    expect(cancel).not.toHaveBeenCalled();
    expect(outcome.wait?.status).toBe("completed");
    expect(outcome.wait?.response_text).toBe("done");
    expect(outcome.cancel_requested).toBe(false);
    expect(outcome.error).toBeNull();
  });

  test("does not cancel a chain that failed on its own", async () => {
    const { ctx, cancel } = makeCtx({
      awaitImpl: () =>
        Promise.resolve({ status: "failed" as const, final_agent: "agent", response_text: null }),
    });

    const outcome = await awaitChainOrCancel(ctx, "conv-failed", { timeoutMs: 5 });

    expect(cancel).not.toHaveBeenCalled();
    expect(outcome.wait?.status).toBe("failed");
    expect(outcome.cancel_requested).toBe(false);
    expect(outcome.error).toBeNull();
  });

  test("cancels the live chain when awaitChain throws after dispatch", async () => {
    const thrown = new Error("lost stream");
    const { ctx, cancel } = makeCtx({
      awaitImpl: () => Promise.reject(thrown),
    });

    const outcome = await awaitChainOrCancel(ctx, "conv-threw", { timeoutMs: 5 });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("conv-threw");
    expect(outcome.wait).toBeNull();
    expect(outcome.error).toBe(thrown);
    expect(outcome.cancel_requested).toBe(true);
  });

  test("a rejecting cancel is captured as cancel_error and never rethrown", async () => {
    const { ctx, cancel } = makeCtx({
      awaitImpl: () =>
        Promise.resolve({ status: "timeout" as const, final_agent: null, response_text: null }),
      cancelImpl: () => Promise.reject(new Error("cancel endpoint down")),
    });

    const outcome = await awaitChainOrCancel(ctx, "conv-stuck", { timeoutMs: 5 });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(outcome.wait?.status).toBe("timeout");
    expect(outcome.cancel_requested).toBe(false);
    expect(outcome.cancel_error).toBe("cancel endpoint down");
  });
});

describe("cancelChainQuietly", () => {
  for (const status of ["completed", "failed", "rejected", "expired"]) {
    test(`does not report a cancel requested for an already ${status} chain`, async () => {
      const db = new Database(":memory:");
      db.exec(
        "CREATE TABLE handoffs (conversation_id TEXT, status TEXT, parent_handoff_id TEXT, ts TEXT)",
      );
      db.query("INSERT INTO handoffs VALUES ('conv', ?, NULL, '2026-01-01')").run(status);
      const { ctx, cancel } = makeCtx({});
      try {
        const outcome = await cancelChainQuietly({ ...ctx, db: () => db }, "conv");
        expect(outcome.cancel_requested).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    });
  }
  test("reports success when ctx.cancel resolves", async () => {
    const { ctx } = makeCtx({});
    const outcome = await cancelChainQuietly(ctx, "conv");
    expect(outcome).toEqual({ cancel_requested: true });
  });

  test("captures a rejecting cancel as cancel_error", async () => {
    const { ctx } = makeCtx({
      cancelImpl: () => Promise.reject(new Error("boom")),
    });
    const outcome = await cancelChainQuietly(ctx, "conv");
    expect(outcome.cancel_requested).toBe(false);
    expect(outcome.cancel_error).toBe("boom");
  });

  test("stringifies non-Error cancel rejections", async () => {
    const reason: Error = "raw failure" as unknown as Error;
    const { ctx } = makeCtx({
      cancelImpl: () => Promise.reject(reason),
    });
    const outcome = await cancelChainQuietly(ctx, "conv");
    expect(outcome.cancel_requested).toBe(false);
    expect(outcome.cancel_error).toBe("raw failure");
  });
});
