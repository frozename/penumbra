import { expect, mock, test } from 'bun:test';
import { longLivedTickHandler } from '../../src/tools/long-lived-tick-mcp.js';

test('long_lived_tick proxies to daemon.longLivedTick', async () => {
  const daemon = { longLivedTick: mock().mockResolvedValue({ outcome: { ok: true } }) } as any;

  const result = await longLivedTickHandler(daemon)({ id: 'home-mgmt' });

  expect(daemon.longLivedTick).toHaveBeenCalledWith('home-mgmt');
  expect(result.content[0].text).toContain('"outcome"');
  expect(result.content[0].text).toContain('"ok": true');
});
