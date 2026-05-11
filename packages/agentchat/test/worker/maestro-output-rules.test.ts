import { expect, test } from 'bun:test';
import { ValuePatternRedactor } from '@penumbra/core';
import { MAESTRO_STATIC_RULES, isFailClosed, buildUnknownAgentRule } from '../../src/worker/maestro-output-rules.js';

const R = new ValuePatternRedactor(MAESTRO_STATIC_RULES);

test('catches rm -rf with path', () => {
  const { hits } = R.redactString('I cannot run rm -rf /Volumes/WorkSSD on shared disks');
  expect(hits.find((h) => h.rule_id === 'destructive_shell_rmrf')?.count).toBe(1);
});

test('catches ssh private key path', () => {
  const { hits } = R.redactString('Reading ~/.ssh/id_ed25519 would violate policy');
  expect(hits.find((h) => h.rule_id === 'ssh_private_key_path')?.count).toBe(1);
});

test('catches git force push to main', () => {
  const { hits } = R.redactString('Refusing: git push --force-with-lease origin/main');
  expect(hits.find((h) => h.rule_id === 'git_force_push')?.count).toBe(1);
});

test('high-stakes rules are flagged fail-closed', () => {
  expect(isFailClosed('destructive_shell_rmrf')).toBe(true);
  expect(isFailClosed('ssh_private_key_path')).toBe(true);
  expect(isFailClosed('git_force_push')).toBe(true);
});

test('benign text is untouched', () => {
  const { hits, redacted } = R.redactString('discussion of file ownership and git pull workflows');
  expect(hits).toEqual([]);
  expect(redacted).toBe('discussion of file ownership and git pull workflows');
});

test('buildUnknownAgentRule fires on unknown agent name in chain_start args', () => {
  const rule = buildUnknownAgentRule(new Set(['claude-acp-sonnet', 'planner']));
  const r2 = new ValuePatternRedactor([rule]);
  const args = '{"initial_agent":"evil-agent-doom","task_type":"unknown"}';
  const { hits, redacted } = r2.redactString(args);
  expect(hits.find((h) => h.rule_id === 'unknown_initial_agent')?.count).toBe(1);
  expect(redacted).toContain('[REDACTED:unknown-agent:evil-agent-doom]');
});

test('buildUnknownAgentRule does not fire on known agents', () => {
  const rule = buildUnknownAgentRule(new Set(['claude-acp-sonnet', 'planner']));
  const r2 = new ValuePatternRedactor([rule]);
  const args = '{"initial_agent":"claude-acp-sonnet","task_type":"review_adversarial"}';
  const { hits, redacted } = r2.redactString(args);
  expect(hits).toEqual([]);
  expect(redacted).toBe(args);
});

test('isFailClosed includes the dynamic unknown_initial_agent rule', () => {
  expect(isFailClosed('unknown_initial_agent')).toBe(true);
});
