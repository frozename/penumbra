import { expect, test } from 'bun:test';
import {
  MAX_WALKER_DEPTH,
  MAX_WALKER_STRING_BYTES,
  ValuePatternRedactor,
} from '../../src/redaction/value-patterns.js';

test('redactValue: non-plain object roots are preserved (Date/URL/Map/RegExp)', () => {
  const r = new ValuePatternRedactor([{ id: 'soft', pattern: /banana/g, replacement: '[REDACTED:soft]' }]);

  const date = new Date('2026-05-11T00:00:00.000Z');
  const url = new URL('https://example.com');
  const map = new Map<string, string>([['k', 'banana']]);
  const regex = /banana/g;

  expect(r.redactValue(date).redacted).toBe(date);
  expect(r.redactValue(url).redacted).toBe(url);
  expect(r.redactValue(map).redacted).toBe(map);
  expect(r.redactValue(regex).redacted).toBe(regex);
});

test('redactValue: recursion cap records synthetic hit and avoids deep traversal', () => {
  const r = new ValuePatternRedactor([
    { id: 'soft_ssh', pattern: /\.ssh\/id_ed25519/g, replacement: '[REDACTED:ssh]' },
  ]);

  let deep: unknown = '.ssh/id_ed25519';
  for (let i = 0; i < MAX_WALKER_DEPTH + 1; i++) {
    deep = { a: deep };
  }

  const walked = r.redactValue(deep, { maxDepth: MAX_WALKER_DEPTH });
  expect(walked.hits.find((h) => h.rule_id === 'walker_depth_exceeded')?.count).toBe(1);
  expect(walked.hits.find((h) => h.rule_id === 'soft_ssh')).toBeUndefined();
});

test('redactValue: oversize string records synthetic hit and preserves original bytes', () => {
  const r = new ValuePatternRedactor([
    { id: 'soft_ssh', pattern: /\.ssh\/id_ed25519/g, replacement: '[REDACTED:ssh]' },
  ]);

  const value = { msg: `${'x'.repeat(100_000)} .ssh/id_ed25519` };
  const walked = r.redactValue(value, { maxStringBytes: MAX_WALKER_STRING_BYTES });

  expect(walked.hits.find((h) => h.rule_id === 'walker_string_oversize')?.count).toBe(1);
  expect((walked.redacted as any).msg).toBe(value.msg);
});

test('redactValue: rewrites string leaves across mixed arrays/objects', () => {
  const r = new ValuePatternRedactor([{ id: 'soft', pattern: /banana/g, replacement: '[REDACTED:soft]' }]);
  const input = { x: [{ y: { z: 'banana' } }] };

  const walked = r.redactValue(input);
  expect(walked.redacted).toEqual({ x: [{ y: { z: '[REDACTED:soft]' } }] });
  expect(walked.hits.find((h) => h.rule_id === 'soft')?.count).toBe(1);
});

test('redactValue: clean array keeps the original reference (no allocation)', () => {
  const r = new ValuePatternRedactor([{ id: 'soft', pattern: /banana/g, replacement: '[REDACTED:soft]' }]);
  const input = Array.from({ length: 100 }, (_, i) => `clean-${i}`);

  const walked = r.redactValue(input);
  expect(walked.hits).toEqual([]);
  expect(walked.redacted).toBe(input);
});
