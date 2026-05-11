import { expect, test } from 'bun:test';
import { ValuePatternRedactor } from '@penumbra/core';
import { MAESTRO_STATIC_RULES, isFailClosed } from '../../src/worker/maestro-output-rules.js';

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
