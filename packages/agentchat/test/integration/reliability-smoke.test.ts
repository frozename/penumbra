import { describe, expect, test } from 'bun:test';

import { runReliabilitySmokeScenario } from '../../scripts/reliability-smoke/run';

describe('reliability smoke scenario classifier expectations', () => {
  test('success_with_output classifies complete', async () => {
    const result = await runReliabilitySmokeScenario('success_with_output', { dryRun: true });

    expect(result.scenario).toBe('success_with_output');
    expect(result.expectedStatus).toBe('complete');
  });

  test('empty_success classifies no_agent_output', async () => {
    const result = await runReliabilitySmokeScenario('empty_success', { dryRun: true });

    expect(result.expectedStatus).toBe('no_agent_output');
  });

  test('implementation_no_diff classifies no_worktree_activity', async () => {
    const result = await runReliabilitySmokeScenario('implementation_no_diff', { dryRun: true });

    expect(result.expectedStatus).toBe('no_worktree_activity');
  });
});
