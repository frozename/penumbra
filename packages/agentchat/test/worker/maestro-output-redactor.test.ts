import { expect, test } from 'bun:test';
import {
  MaestroOutputRedactor,
  MAX_WALKER_DEPTH,
  MAX_WALKER_STRING_BYTES,
  walkAndRedact,
} from '../../src/worker/maestro-output-redactor.js';

test('orchestrator combines static and dynamic rules', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
  });
  const { decision, content, hits } = m.checkContent(
    'forwarding rm -rf /Volumes/WorkSSD to the agent'
  );
  expect(decision).toBe('blocked');
  expect(content).toContain('[REDACTED:rm-rf]');
  expect(hits.find((h) => h.rule_id === 'destructive_shell_rmrf')?.count).toBe(1);
});

test('orchestrator returns clean for benign content', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
  });
  const { decision, content, hits } = m.checkContent('benign discussion of plans');
  expect(decision).toBe('clean');
  expect(content).toBe('benign discussion of plans');
  expect(hits).toEqual([]);
});

test('orchestrator bypass returns clean even on dangerous content', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: true,
  });
  const { decision, content, hits, bypassed } = m.checkContent(
    'rm -rf /Volumes/WorkSSD'
  );
  expect(decision).toBe('bypassed');
  expect(content).toBe('rm -rf /Volumes/WorkSSD');
  expect(bypassed).toBe(true);
  // We still surface the hits so audit can see what would have been caught.
  expect(hits.find((h) => h.rule_id === 'destructive_shell_rmrf')?.count).toBe(1);
});

test('orchestrator silently rewrites when only soft-rules match', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
    extraRules: [
      { id: 'soft_rule', pattern: /banana/g, replacement: '[REDACTED:soft]' },
    ],
  });
  const { decision, content } = m.checkContent('I like banana');
  expect(decision).toBe('rewritten');
  expect(content).toBe('I like [REDACTED:soft]');
});

test('checkContent stays under 1 ms on a 4 KB response', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
  });
  const text = 'lorem ipsum '.repeat(330) + 'rm -rf /Volumes/WorkSSD trailing';
  expect(text.length).toBeGreaterThan(3500);
  // Warmup once to let the JIT settle.
  m.checkContent(text);
  const start = performance.now();
  for (let i = 0; i < 100; i++) m.checkContent(text);
  const ms = (performance.now() - start) / 100;
  expect(ms).toBeLessThan(1);
});

test('walkAndRedact: pure string behaves like checkValue', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
    extraRules: [{ id: 'soft_rule', pattern: /banana/g, replacement: '[REDACTED:soft]' }],
  });
  const walked = walkAndRedact('banana', m);
  expect(walked.decision).toBe('rewritten');
  expect(walked.value).toBe('[REDACTED:soft]');
  expect(walked.hits.find((h) => h.rule_id === 'soft_rule')?.count).toBe(1);
});

test('walkAndRedact: nested object hits at depth 3', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
    extraRules: [{ id: 'soft_rule', pattern: /banana/g, replacement: '[REDACTED:soft]' }],
  });
  const value = { a: { b: { c: 'banana' } } };
  const walked = walkAndRedact(value, m);
  expect(walked.decision).toBe('rewritten');
  expect(walked.value).toEqual({ a: { b: { c: '[REDACTED:soft]' } } });
});

test('walkAndRedact: array of strings with one hit', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
    extraRules: [{ id: 'soft_rule', pattern: /banana/g, replacement: '[REDACTED:soft]' }],
  });
  const walked = walkAndRedact(['apple', 'banana', 'pear'], m);
  expect(walked.decision).toBe('rewritten');
  expect(walked.value).toEqual(['apple', '[REDACTED:soft]', 'pear']);
});

test('walkAndRedact: deep mixed object/array rewrites deepest hit', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
    extraRules: [{ id: 'soft_rule', pattern: /banana/g, replacement: '[REDACTED:soft]' }],
  });
  const walked = walkAndRedact(
    {
      x: [{ y: { z: 'banana' } }],
    },
    m,
  );
  expect(walked.decision).toBe('rewritten');
  expect(walked.value).toEqual({ x: [{ y: { z: '[REDACTED:soft]' } }] });
});

test('walkAndRedact: fail-closed hit blocks whole value', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
  });
  const value = { nested: ['safe', { cmd: 'rm -rf /Volumes/WorkSSD' }] };
  const walked = walkAndRedact(value, m);
  expect(walked.decision).toBe('blocked');
  expect(walked.value).toEqual(value);
  expect(walked.hits.find((h) => h.rule_id === 'destructive_shell_rmrf')?.count).toBe(1);
});

test('walkAndRedact: bypass preserves original value and records hits', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: true,
  });
  const value = { nested: { key: 'rm -rf /Volumes/WorkSSD' } };
  const walked = walkAndRedact(value, m);
  expect(walked.decision).toBe('bypassed');
  expect(walked.bypassed).toBe(true);
  expect(walked.value).toEqual(value);
  expect(walked.hits.find((h) => h.rule_id === 'destructive_shell_rmrf')?.count).toBe(1);
});

test('walkAndRedact: non-plain Date root is opaque and preserved', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
  });
  const value = new Date('2026-05-11T00:00:00.000Z');
  const walked = walkAndRedact(value, m);
  expect(walked.decision).toBe('clean');
  expect(walked.hits).toEqual([]);
  expect(walked.value).toBe(value);
});

test('walkAndRedact: Date instance inside object is preserved while sibling string is redacted', () => {
  const m = {
    checkValue<T>(input: T) {
      if (typeof input !== 'string') return { decision: 'clean' as const, value: input, hits: [], bypassed: false };
      if (!input.includes('.ssh/id_ed25519')) return { decision: 'clean' as const, value: input, hits: [], bypassed: false };
      return {
        decision: 'rewritten' as const,
        value: input.replace('.ssh/id_ed25519', '[REDACTED:ssh]'),
        hits: [{ rule_id: 'soft_ssh', count: 1 }],
        bypassed: false,
      };
    },
  };
  const value = { ts: new Date('2026-05-11T00:00:00.000Z'), msg: '.ssh/id_ed25519' };
  const walked = walkAndRedact(value, m);
  expect(walked.decision).toBe('rewritten');
  expect((walked.value as any).ts instanceof Date).toBe(true);
  expect((walked.value as any).msg).toBe('[REDACTED:ssh]');
});

test('walkAndRedact: non-plain URL root is opaque and preserved', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
  });
  const value = new URL('https://example.com');
  const walked = walkAndRedact(value, m);
  expect(walked.decision).toBe('clean');
  expect(walked.hits).toEqual([]);
  expect(walked.value).toBe(value);
});

test('walkAndRedact: array preserves Date instance and redacts sibling string', () => {
  const m = {
    checkValue<T>(input: T) {
      if (typeof input !== 'string') return { decision: 'clean' as const, value: input, hits: [], bypassed: false };
      if (!input.includes('.ssh/id_ed25519')) return { decision: 'clean' as const, value: input, hits: [], bypassed: false };
      return {
        decision: 'rewritten' as const,
        value: input.replace('.ssh/id_ed25519', '[REDACTED:ssh]'),
        hits: [{ rule_id: 'soft_ssh', count: 1 }],
        bypassed: false,
      };
    },
  };
  const value = [new Date('2026-05-11T00:00:00.000Z'), '.ssh/id_ed25519'];
  const walked = walkAndRedact(value, m);
  expect(walked.decision).toBe('rewritten');
  expect((walked.value as any[])[0] instanceof Date).toBe(true);
  expect((walked.value as any[])[1]).toBe('[REDACTED:ssh]');
});

test('walkAndRedact: recursion cap prevents deep traversal and records depth hit', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
    extraRules: [{ id: 'soft_ssh', pattern: /\.ssh\/id_ed25519/g, replacement: '[REDACTED:ssh]' }],
  });
  let deep: unknown = '.ssh/id_ed25519';
  for (let i = 0; i < MAX_WALKER_DEPTH + 1; i++) {
    deep = { a: deep };
  }
  const walked = walkAndRedact(deep, m, { maxDepth: MAX_WALKER_DEPTH });
  expect(walked.hits.find((h) => h.rule_id === 'walker_depth_exceeded')?.count).toBe(1);
  expect(walked.hits.find((h) => h.rule_id === 'soft_ssh')).toBeUndefined();
});

test('walkAndRedact: oversize string records audit hit and skips full rewrite', () => {
  const m = new MaestroOutputRedactor({
    knownAgents: new Set(['planner']),
    bypass: false,
    extraRules: [{ id: 'soft_ssh', pattern: /\.ssh\/id_ed25519/g, replacement: '[REDACTED:ssh]' }],
  });
  const value = { msg: `${'x'.repeat(100_000)} .ssh/id_ed25519` };
  const walked = walkAndRedact(value, m, { maxStringBytes: MAX_WALKER_STRING_BYTES });
  expect(walked.hits.find((h) => h.rule_id === 'walker_string_oversize')?.count).toBe(1);
  expect((walked.value as any).msg).toBe(value.msg);
});
