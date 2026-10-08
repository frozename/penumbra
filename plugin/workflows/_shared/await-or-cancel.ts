import type { WorkflowCtx } from "@penumbra/workflows";

export const DEFAULT_WAIT_TIMEOUT_MS = 7_200_000;

export type AwaitedChain = Awaited<ReturnType<WorkflowCtx["awaitChain"]>>;

export type CancelOutcome = {
  cancel_requested: boolean;
  cancel_error?: string;
};

export type AwaitOrCancelOutcome = CancelOutcome & {
  // null exactly when ctx.awaitChain threw; error then carries the thrown value.
  wait: AwaitedChain | null;
  error: unknown;
};

// ctx.cancel must never break the caller's own error path: a dispatch the
// caller is abandoning is best-effort to stop, and a rejected cancel is data,
// not a new failure.
export async function cancelChainQuietly(
  ctx: Pick<WorkflowCtx, "cancel" | "db">,
  conversationId: string,
): Promise<CancelOutcome> {
  if (isAlreadyTerminal(ctx, conversationId)) return { cancel_requested: false };
  try {
    await ctx.cancel(conversationId);
    return { cancel_requested: true };
  } catch (err) {
    return {
      cancel_requested: false,
      cancel_error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isAlreadyTerminal(ctx: Pick<WorkflowCtx, "db">, conversationId: string): boolean {
  try {
    const row = ctx
      .db?.()
      .query<{ status: string }, [string]>(
        `SELECT status FROM handoffs WHERE conversation_id = ? AND parent_handoff_id IS NULL
       ORDER BY ts ASC LIMIT 1`,
      )
      .get(conversationId);
    return (
      row !== null &&
      row !== undefined &&
      ["completed", "failed", "rejected", "expired"].includes(row.status)
    );
  } catch {
    return false;
  }
}

// Await a dispatched chain; when the caller abandons a still-live chain (wait
// timed out, or the await itself threw) cancel it so workers stop retrying a
// dispatch nobody is watching. A chain that completed or failed on its own is
// already terminal and is never cancelled here.
export async function awaitChainOrCancel(
  ctx: Pick<WorkflowCtx, "awaitChain" | "cancel" | "db">,
  conversationId: string,
  opts?: { timeoutMs?: number },
): Promise<AwaitOrCancelOutcome> {
  let wait: AwaitedChain;
  try {
    wait = await ctx.awaitChain(conversationId, {
      timeoutMs: opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    });
  } catch (error) {
    const cancel = await cancelChainQuietly(ctx, conversationId);
    return { wait: null, error, ...cancel };
  }
  if (wait.status === "timeout") {
    const undo = recordTimeoutCancel(ctx, conversationId);
    const cancel = await cancelChainQuietly(ctx, conversationId);
    if (!cancel.cancel_requested) {
      try {
        undo();
      } catch {
        /* A failed diagnostic cleanup must not break abandonment. */
      }
    }
    return { wait, error: null, ...cancel };
  }
  return { wait, error: null, cancel_requested: false };
}

function recordTimeoutCancel(ctx: Pick<WorkflowCtx, "db">, conversationId: string): () => void {
  try {
    const db = ctx.db?.();
    if (!db) return () => undefined;
    // Record before broadcasting cancellation: the worker can finish immediately.
    // Existing cancels retain their original cause; only live, unmarked rows qualify.
    const rows = db
      .query<{ id: number }, [string, string]>(
        `INSERT INTO dispatch_events (handoff_id, source, kind, ts)
       SELECT handoff_id, 'workflow', 'workflow.cancel.wait_timeout', ? FROM handoffs
       WHERE conversation_id = ? AND cancel_requested_at IS NULL
         AND status IN ('pending', 'approved', 'redirected', 'dispatched') RETURNING id`,
      )
      .all(new Date().toISOString(), conversationId);
    return () => {
      for (const row of rows) db.query("DELETE FROM dispatch_events WHERE id = ?").run(row.id);
    };
  } catch {
    return () => undefined;
  }
}
