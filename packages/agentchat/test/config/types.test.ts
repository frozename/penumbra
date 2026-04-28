import { describe, expect, test } from 'bun:test';
import { AgentOptionsSchema } from '../../src/config/types.js';

describe('AgentOptionsSchema — Phase 1d boolean opt-ins', () => {
  test('fsReadTextFile defaults to undefined', () => {
    const result = AgentOptionsSchema.parse({});
    expect(result.fsReadTextFile).toBeUndefined();
  });

  test('fsReadTextFile parses true', () => {
    const result = AgentOptionsSchema.parse({ fsReadTextFile: true });
    expect(result.fsReadTextFile).toBe(true);
  });

  test('fsReadTextFile rejects non-boolean', () => {
    expect(() => AgentOptionsSchema.parse({ fsReadTextFile: 'yes' })).toThrow();
  });

  test('fsWriteTextFile defaults to undefined', () => {
    const result = AgentOptionsSchema.parse({});
    expect(result.fsWriteTextFile).toBeUndefined();
  });

  test('fsWriteTextFile parses true', () => {
    const result = AgentOptionsSchema.parse({ fsWriteTextFile: true });
    expect(result.fsWriteTextFile).toBe(true);
  });

  test('fsWriteTextFile rejects non-boolean', () => {
    expect(() => AgentOptionsSchema.parse({ fsWriteTextFile: 1 })).toThrow();
  });

  test('terminal defaults to undefined', () => {
    const result = AgentOptionsSchema.parse({});
    expect(result.terminal).toBeUndefined();
  });

  test('terminal parses true', () => {
    const result = AgentOptionsSchema.parse({ terminal: true });
    expect(result.terminal).toBe(true);
  });

  test('terminal rejects non-boolean', () => {
    expect(() => AgentOptionsSchema.parse({ terminal: 'yes' })).toThrow();
  });

  test('mcpWriteTools defaults to undefined', () => {
    const result = AgentOptionsSchema.parse({});
    expect(result.mcpWriteTools).toBeUndefined();
  });

  test('mcpWriteTools parses true', () => {
    const result = AgentOptionsSchema.parse({ mcpWriteTools: true });
    expect(result.mcpWriteTools).toBe(true);
  });

  test('mcpWriteTools rejects non-boolean', () => {
    expect(() => AgentOptionsSchema.parse({ mcpWriteTools: 0 })).toThrow();
  });
});

describe('AgentOptionsSchema — Phase 1d sandbox knobs', () => {
  test('terminal_path parses a string', () => {
    const result = AgentOptionsSchema.parse({ terminal_path: '/usr/bin:/bin' });
    expect(result.terminal_path).toBe('/usr/bin:/bin');
  });

  test('terminal_timeout_s — 30 parses', () => {
    const result = AgentOptionsSchema.parse({ terminal_timeout_s: 30 });
    expect(result.terminal_timeout_s).toBe(30);
  });

  test('terminal_timeout_s — 0 throws', () => {
    expect(() => AgentOptionsSchema.parse({ terminal_timeout_s: 0 })).toThrow();
  });

  test('terminal_timeout_s — 301 throws', () => {
    expect(() => AgentOptionsSchema.parse({ terminal_timeout_s: 301 })).toThrow();
  });

  test('terminal_output_max_bytes — 1048576 parses', () => {
    const result = AgentOptionsSchema.parse({ terminal_output_max_bytes: 1048576 });
    expect(result.terminal_output_max_bytes).toBe(1048576);
  });

  test('terminal_output_max_bytes — 8388609 throws', () => {
    expect(() => AgentOptionsSchema.parse({ terminal_output_max_bytes: 8388609 })).toThrow();
  });

  test('terminal_output_max_bytes — 1023 throws', () => {
    expect(() => AgentOptionsSchema.parse({ terminal_output_max_bytes: 1023 })).toThrow();
  });

  test('terminal_max_concurrent — 3 parses', () => {
    const result = AgentOptionsSchema.parse({ terminal_max_concurrent: 3 });
    expect(result.terminal_max_concurrent).toBe(3);
  });

  test('terminal_max_concurrent — 9 throws', () => {
    expect(() => AgentOptionsSchema.parse({ terminal_max_concurrent: 9 })).toThrow();
  });

  test('terminal_max_concurrent — 0 throws', () => {
    expect(() => AgentOptionsSchema.parse({ terminal_max_concurrent: 0 })).toThrow();
  });
});
