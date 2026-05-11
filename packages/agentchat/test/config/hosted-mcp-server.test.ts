import { describe, expect, test } from 'bun:test';
import { HostedMcpServerSchema } from '../../src/config/types.js';

describe('HostedMcpServerSchema', () => {
  test('requires name and command, with default args and env', () => {
    const result = HostedMcpServerSchema.parse({
      name: 'server-one',
      command: 'node',
    });

    expect(result.args).toEqual([]);
    expect(result.env).toEqual([]);
  });

  test('rejects empty name', () => {
    expect(() => HostedMcpServerSchema.parse({
      name: '',
      command: 'node',
    })).toThrow();
  });

  test('rejects empty command', () => {
    expect(() => HostedMcpServerSchema.parse({
      name: 'server-one',
      command: '',
    })).toThrow();
  });

  test('allows empty env value strings', () => {
    const result = HostedMcpServerSchema.parse({
      name: 'server-one',
      command: 'node',
      env: [{ name: 'TOKEN', value: '' }],
    });

    expect(result.env).toEqual([{ name: 'TOKEN', value: '' }]);
  });

  test('rejects non-string args entries', () => {
    expect(() => HostedMcpServerSchema.parse({
      name: 'server-one',
      command: 'node',
      args: ['--flag', 1],
    })).toThrow();
  });
});
