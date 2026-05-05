import { expect, test } from 'bun:test';
import type { BoundsConsumed } from '@penumbra/core';
import { formatBudgetWarning } from '../../src/maestro/warning-text.js';

const BASE_BUDGETS = {
  wall_clock_budget_ms: 30 * 60_000,
  cost_budget_cents: 200,
  sub_dispatch_budget: 10,
};

const BASE_CONSUMED: BoundsConsumed = {
  wall_clock_ms: 24 * 60_000,
  cost_cents: 160,
  sub_dispatches: 8,
  pct: 0.85,
  axis_breakdown: {
    wall_clock: 0.8,
    cost: 0.8,
    sub_dispatches: 0.8,
  },
};

test('renders the exact budget warning text from spec', () => {
  const output = formatBudgetWarning(BASE_CONSUMED, BASE_BUDGETS);
  expect(output).toBe(
    `BUDGET WARNING — wrap up now.
Wall-clock: 24 / 30 min (80%)
Cost: $1.60 / $2.00 (80%)
Sub-dispatches: 8 / 10 (80%)

You have ~20% remaining on at least one axis. Call task.complete with what you have, or task.fail with a reason. If you call chain_start now and it returns 429 BudgetExceeded, you must call task.fail.`,
  );
});

test('formats cost cents as dollars with two decimal places', () => {
  const cases: Array<{ cents: number; expected: string }> = [
    { cents: 0, expected: '$0.00' },
    { cents: 1, expected: '$0.01' },
    { cents: 99, expected: '$0.99' },
    { cents: 100, expected: '$1.00' },
    { cents: 12345, expected: '$123.45' },
  ];

  for (const c of cases) {
    const output = formatBudgetWarning(
      { ...BASE_CONSUMED, cost_cents: c.cents },
      BASE_BUDGETS,
    );
    expect(output).toContain(`Cost: ${c.expected} / $2.00 (80%)`);
  }
});

test('rounds percentages to nearest integer', () => {
  const wall799 = formatBudgetWarning(
    { ...BASE_CONSUMED, axis_breakdown: { ...BASE_CONSUMED.axis_breakdown, wall_clock: 0.799 } },
    BASE_BUDGETS,
  );
  expect(wall799).toContain('Wall-clock: 24 / 30 min (80%)');

  const wall794 = formatBudgetWarning(
    { ...BASE_CONSUMED, axis_breakdown: { ...BASE_CONSUMED.axis_breakdown, wall_clock: 0.794 } },
    BASE_BUDGETS,
  );
  expect(wall794).toContain('Wall-clock: 24 / 30 min (79%)');

  const cost85 = formatBudgetWarning(
    { ...BASE_CONSUMED, axis_breakdown: { ...BASE_CONSUMED.axis_breakdown, cost: 0.85 } },
    BASE_BUDGETS,
  );
  expect(cost85).toContain('Cost: $1.60 / $2.00 (85%)');

  const sub999 = formatBudgetWarning(
    { ...BASE_CONSUMED, axis_breakdown: { ...BASE_CONSUMED.axis_breakdown, sub_dispatches: 0.999 } },
    BASE_BUDGETS,
  );
  expect(sub999).toContain('Sub-dispatches: 8 / 10 (100%)');
});
