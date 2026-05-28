import type { BoundsConsumed } from "@penumbra/core";

interface WarningBudgets {
  wall_clock_budget_ms: number;
  cost_budget_cents: number;
  sub_dispatch_budget: number;
}

export function formatBudgetWarning(consumed: BoundsConsumed, budgets: WarningBudgets): string {
  const consumedMin = Math.round(consumed.wall_clock_ms / 60_000);
  const budgetMin = Math.round(budgets.wall_clock_budget_ms / 60_000);
  const wallPct = Math.round(consumed.axis_breakdown.wall_clock * 100);

  const consumedDollars = (consumed.cost_cents / 100).toFixed(2);
  const budgetDollars = (budgets.cost_budget_cents / 100).toFixed(2);
  const costPct = Math.round(consumed.axis_breakdown.cost * 100);

  const consumedSubs = consumed.sub_dispatches;
  const budgetSubs = budgets.sub_dispatch_budget;
  const subPct = Math.round(consumed.axis_breakdown.sub_dispatches * 100);

  return `BUDGET WARNING — wrap up now.
Wall-clock: ${consumedMin} / ${budgetMin} min (${wallPct}%)
Cost: $${consumedDollars} / $${budgetDollars} (${costPct}%)
Sub-dispatches: ${consumedSubs} / ${budgetSubs} (${subPct}%)

You have ~20% remaining on at least one axis. Call task.complete with what you have, or task.fail with a reason. If you call chain_start now and it returns 429 BudgetExceeded, you must call task.fail.`;
}
