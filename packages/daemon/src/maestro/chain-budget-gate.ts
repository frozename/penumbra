import type { Database } from "bun:sqlite";

import { type MaestroSessionWriter } from "@penumbra/core";

export function enforceMaestroBudget(opts: {
  db: Database;
  sessions: MaestroSessionWriter;
  parent_handoff_id: string | undefined;
}):
  | { ok: true }
  | {
      ok: false;
      status: 429;
      body: {
        error: "BudgetExceeded";
        axis: "sub_dispatches";
        limit: number;
        observed: number;
      };
    } {
  void opts.db;
  const parentHandoffId = opts.parent_handoff_id?.trim();
  if (!parentHandoffId) {
    return { ok: true };
  }

  const session = opts.sessions.getByChainHandoff(parentHandoffId);
  if (session?.terminated_at !== null) {
    return { ok: true };
  }

  if (session.sub_dispatches_consumed >= session.sub_dispatch_budget) {
    return {
      ok: false,
      status: 429,
      body: {
        error: "BudgetExceeded",
        axis: "sub_dispatches",
        limit: session.sub_dispatch_budget,
        observed: session.sub_dispatches_consumed,
      },
    };
  }

  opts.sessions.incrementSubDispatch(session.task_id);
  return { ok: true };
}
