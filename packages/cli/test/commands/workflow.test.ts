import { expect, test } from 'bun:test';
import { runWorkflowList } from '../../src/commands/workflow.js';

test('runWorkflowList prints names + descriptions', async () => {
  const calls: string[] = [];
  const out = (s: string) => calls.push(s);
  const fakeFetch = async () => ({ workflows: [{ name: 'demo', description: 'd', triggers: [] }] });
  await runWorkflowList({ out, fetchList: fakeFetch });
  expect(calls.join('\n')).toContain('demo');
  expect(calls.join('\n')).toContain('d');
});

test('runWorkflowList prints "(no workflows registered)" on empty', async () => {
  const calls: string[] = [];
  await runWorkflowList({ out: (s) => calls.push(s), fetchList: async () => ({ workflows: [] }) });
  expect(calls.join('\n')).toContain('no workflows');
});
