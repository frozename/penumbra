import { expect, test } from 'bun:test';
import { parsePlanMeta } from '../../src/plan-meta/parser.js';

test('parses valid yaml meta blocks in document order', () => {
  const markdown = [
    '# Plan',
    '',
    '```yaml meta',
    'id: "1.1"',
    'files:',
    '  - packages/workflows/src/a.ts',
    'file_scope: new',
    'depends_on: []',
    'parallel_with: []',
    'preferred_agent: codex-acp-fast',
    'fallback_agent: claude-acp-sonnet',
    'task_size: small',
    'risk_class: paste-ready',
    '```',
    '',
    'text',
    '',
    '```yaml meta',
    'id: "1.2"',
    'files:',
    '  - packages/workflows/src/b.ts',
    'file_scope: modify-existing',
    'depends_on: ["1.1"]',
    'parallel_with: []',
    'preferred_agent: gemini-acp-flash',
    'fallback_agent: claude-acp-sonnet',
    'task_size: substantial',
    'risk_class: schema-aware',
    '```',
  ].join('\n');

  const result = parsePlanMeta(markdown);
  expect(result.tasks).toHaveLength(2);
  expect(result.errors).toHaveLength(0);
  expect(result.tasks.map((task) => task.id)).toEqual(['1.1', '1.2']);
});

test('reports malformed yaml as an error', () => {
  const markdown = [
    '```yaml meta',
    'id: "1.1"',
    'files:',
    '  - packages/workflows/src/a.ts',
    'file_scope: new',
    'depends_on: []',
    'parallel_with: []',
    'preferred_agent: codex-acp-fast',
    'fallback_agent: claude-acp-sonnet',
    'task_size: small',
    'risk_class: paste-ready',
    '```',
    '',
    '```yaml meta',
    'id: "1.2"',
    'files:',
    '  - packages/workflows/src/b.ts',
    'file_scope: modify-existing',
    'depends_on: [',
    'parallel_with: []',
    'preferred_agent: gemini-acp-flash',
    'fallback_agent: claude-acp-sonnet',
    'task_size: substantial',
    'risk_class: schema-aware',
    '```',
  ].join('\n');

  const result = parsePlanMeta(markdown);
  expect(result.tasks).toHaveLength(1);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].line).toBeGreaterThan(0);
  expect(result.errors[0].reason.length).toBeGreaterThan(0);
});

test('reports schema rejection as an error', () => {
  const markdown = [
    '```yaml meta',
    'id: "1.1"',
    'files:',
    '  - packages/workflows/src/a.ts',
    'file_scope: new',
    'depends_on: []',
    'parallel_with: []',
    'preferred_agent: codex-acp-fast',
    'fallback_agent: claude-acp-sonnet',
    'risk_class: paste-ready',
    '```',
  ].join('\n');

  const result = parsePlanMeta(markdown);
  expect(result.tasks).toHaveLength(0);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].line).toBe(1);
  expect(result.errors[0].reason.length).toBeGreaterThan(0);
});

test('returns an empty result when no yaml meta blocks exist', () => {
  const result = parsePlanMeta('# Nothing here\n\n```ts\nconst x = 1;\n```\n');
  expect(result.tasks).toHaveLength(0);
  expect(result.errors).toHaveLength(0);
});
