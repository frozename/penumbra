import { expect, test } from 'bun:test';
import { TaskMetaSchema } from '../../src/plan-meta/schema.js';

test('accepts a minimal valid block', () => {
  const r = TaskMetaSchema.safeParse({
    id: '3.1',
    files: ['packages/workflows/src/x.ts'],
    file_scope: 'new',
    depends_on: [],
    parallel_with: ['3.2'],
    preferred_agent: 'codex-acp-fast',
    fallback_agent: 'claude-acp-sonnet',
    task_size: 'small',
    risk_class: 'paste-ready',
  });
  expect(r.success).toBe(true);
});

test('rejects unknown task_size', () => {
  const r = TaskMetaSchema.safeParse({
    id: '3.1', files: ['x.ts'], file_scope: 'new', depends_on: [], parallel_with: [],
    preferred_agent: 'codex-acp-fast', fallback_agent: 'claude-acp-sonnet',
    task_size: 'enormous', risk_class: 'paste-ready',
  });
  expect(r.success).toBe(false);
});

test('rejects unknown risk_class', () => {
  const r = TaskMetaSchema.safeParse({
    id: '3.1', files: ['x.ts'], file_scope: 'new', depends_on: [], parallel_with: [],
    preferred_agent: 'codex-acp-fast', fallback_agent: 'claude-acp-sonnet',
    task_size: 'small', risk_class: 'mystery',
  });
  expect(r.success).toBe(false);
});
