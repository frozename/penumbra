import { afterEach, expect, mock, test } from 'bun:test';

let capturedSpawnOpts: {
  env?: Record<string, string>;
} | null = null;
let capturedConfig: Record<string, unknown> | null = null;
let capturedConfigPath: string | null = null;

mock.module('../../src/adapters/cli-spawn.js', () => ({
  spawnCliAdapter: mock(async (opts: { env?: Record<string, string> }) => {
    capturedSpawnOpts = opts;
    const xdgConfigHome = opts.env?.XDG_CONFIG_HOME;
    if (!xdgConfigHome) {
      throw new Error('missing XDG_CONFIG_HOME');
    }
    capturedConfigPath = `${xdgConfigHome}/opencode/config.json`;
    const text = Bun.file(capturedConfigPath);
    expect(await text.exists()).toBe(true);
    capturedConfig = JSON.parse(await text.text());
    return { text: 'ok', stderr: '' };
  }),
}));

mock.module('../../src/adapters/secret.js', () => ({
  resolveAdapterApiKey: mock(() => 'mock-key'),
}));

const { OpencodeCliAdapter } = await import('../../src/adapters/opencode-cli.js');

afterEach(() => {
  capturedSpawnOpts = null;
  capturedConfig = null;
  capturedConfigPath = null;
});

test('opencode-cli sets a per-dispatch XDG_CONFIG_HOME when mcpServers are provided', async () => {
  const adapter = new OpencodeCliAdapter({
    model: 'gpt-5',
    command: 'cat',
    args: [],
    pass_via: 'stdin',
    mcpServers: [
      {
        name: 'penumbra',
        command: 'bun',
        args: ['/tmp/penumbra-mcp.ts'],
        env: [{ name: 'PENUMBRA_STORAGE_ROOT', value: '/tmp/penumbra-live' }],
      } as any,
    ],
  });

  const out = await adapter.dispatch({
    prompt: 'hi opencode',
    conversation: { id: 'c', project_id: null },
    config: {},
    signal: new AbortController().signal,
  });

  expect(out.text).toBe('ok');
  expect(capturedSpawnOpts?.env?.XDG_CONFIG_HOME).toBeDefined();
  expect(capturedSpawnOpts?.env?.OPENCODE_API_KEY).toBe('mock-key');
  expect(capturedConfig).toEqual({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      penumbra: {
        type: 'local',
        command: ['bun', '/tmp/penumbra-mcp.ts'],
        environment: { PENUMBRA_STORAGE_ROOT: '/tmp/penumbra-live' },
        enabled: true,
      },
    },
  });
  expect(capturedConfigPath).toBeDefined();
  expect(capturedConfigPath && (await Bun.file(capturedConfigPath).exists())).toBe(false);
});
