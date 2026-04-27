import { expect, test, mock } from 'bun:test';
import { daemonReloadConfigHandler, DaemonReloadConfigInputShape } from '../../src/tools/daemon-reload-config.js';

test('DaemonReloadConfigInputShape is empty', () => {
  expect(DaemonReloadConfigInputShape).toEqual({});
});

test('daemonReloadConfigHandler calls daemon.reloadConfig and formats output', async () => {
  const daemon = {
    reloadConfig: mock().mockResolvedValue({
      ok: true,
      agent_count: 5,
      reloaded_at: '2026-04-26T00:00:00.000Z',
    }),
  } as any;

  const handler = daemonReloadConfigHandler(daemon);
  const res = await handler({});

  expect(daemon.reloadConfig).toHaveBeenCalledTimes(1);
  expect(res.content[0].type).toBe('text');
  expect(JSON.parse(res.content[0].text)).toEqual({
    ok: true,
    agent_count: 5,
    reloaded_at: '2026-04-26T00:00:00.000Z',
  });
});
