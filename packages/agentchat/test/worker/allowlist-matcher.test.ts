import { describe, expect, test } from 'bun:test';
import { matchAllowlist } from '../../src/worker/allowlist-matcher.js';

describe('matchAllowlist', () => {
  test('exact match (no glob chars) succeeds', () => {
    expect(matchAllowlist(['fs.readTextFile'], new Set(), 'fs.readTextFile')).toBe(true);
  });

  test('exact match against a different name fails', () => {
    expect(matchAllowlist(['fs.readTextFile'], new Set(), 'fs.writeTextFile')).toBe(false);
  });

  test('glob with * matches its scope but not other servers', () => {
    expect(matchAllowlist(['mcp__penumbra__*'], new Set(), 'mcp__penumbra__chain.list_agents')).toBe(true);
    expect(matchAllowlist(['mcp__penumbra__*'], new Set(), 'mcp__sirius__sirius_chat')).toBe(false);
  });

  test('glob with ? matches single-char gap', () => {
    expect(matchAllowlist(['fs.read?extFile'], new Set(), 'fs.readTextFile')).toBe(true);
  });

  test('character class [...] is treated as glob', () => {
    expect(matchAllowlist(['mcp__[ps]enumbra__*'], new Set(), 'mcp__penumbra__x')).toBe(true);
    expect(matchAllowlist(['mcp__[ps]enumbra__*'], new Set(), 'mcp__qenumbra__x')).toBe(false);
  });

  test('per-dispatch cache short-circuits even when not in yaml list', () => {
    expect(matchAllowlist([], new Set(['ephemeral.tool']), 'ephemeral.tool')).toBe(true);
  });

  test('empty allowlist + empty cache -> no match', () => {
    expect(matchAllowlist([], new Set(), 'fs.readTextFile')).toBe(false);
  });

  test('multiple patterns: any match wins', () => {
    expect(matchAllowlist(['fs.*', 'mcp__penumbra__*'], new Set(), 'mcp__penumbra__memory.recall')).toBe(true);
  });
});
