import { expect, test, describe } from 'bun:test';
import { Test } from '@nestjs/testing';
import { PenumbraMiddlewareModule } from '../src/module.js';
import { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from '../src/tokens.js';
import type { MiddlewareConfig } from '../src/config.js';
import type { PenumbraDaemonClient } from '../src/daemon-client.js';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

describe('PenumbraMiddlewareModule', () => {
  test('compiles when env vars are set; provides enabled config and a real client', async () => {
    await withEnv(
      { PENUMBRA_DAEMON_URL: 'http://127.0.0.1:9999', PENUMBRA_DAEMON_TOKEN: 'tk-7' },
      async () => {
        const m = await Test.createTestingModule({ imports: [PenumbraMiddlewareModule] }).compile();
        const cfg = m.get<MiddlewareConfig>(PENUMBRA_CONFIG);
        const client = m.get<PenumbraDaemonClient>(PENUMBRA_DAEMON_CLIENT);
        expect(cfg.kind).toBe('enabled');
        expect(client).toBeDefined();
        expect(typeof client.observe).toBe('function');
        await m.close();
      },
    );
  });

  test('compiles when env vars are missing; provides disabled config and a stub client', async () => {
    await withEnv(
      { PENUMBRA_DAEMON_URL: undefined, PENUMBRA_DAEMON_TOKEN: undefined },
      async () => {
        const m = await Test.createTestingModule({ imports: [PenumbraMiddlewareModule] }).compile();
        const cfg = m.get<MiddlewareConfig>(PENUMBRA_CONFIG);
        const client = m.get<PenumbraDaemonClient>(PENUMBRA_DAEMON_CLIENT);
        expect(cfg.kind).toBe('disabled');
        // The disabled-state stub is callable but a no-op.
        await expect(client.observe({} as never)).resolves.toBeUndefined();
        await m.close();
      },
    );
  });
});
