import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { Controller, Post, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  spawnPenumbra,
  waitForPortFile,
  captureOutput,
  killGracefully,
  drainOutput,
  type BunSubprocess,
  makeSandbox,
  type Sandbox,
} from '@penumbra/e2e';
import { PenumbraMiddlewareModule } from '../src/index.js';

const SHOULD_RUN = process.env.PENUMBRA_E2E === '1';
const describeIf = SHOULD_RUN ? describe : describe.skip;

@Controller()
class FakeChatController {
  @Post('v1/chat/completions')
  chat(): unknown {
    return {
      model: 'fake-model',
      provider: 'fake-provider',
      choices: [{ index: 0, message: { role: 'assistant', content: 'integration ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    };
  }
}

@Module({ controllers: [FakeChatController], imports: [PenumbraMiddlewareModule] })
class IntegrationAppModule {}

describeIf('sirius-middleware integration with real penumbra daemon', () => {
  let sb: Sandbox;
  let daemon: BunSubprocess | null = null;
  let prevEnv: { url?: string; token?: string };

  beforeEach(async () => {
    sb = makeSandbox();
    expect((await captureOutput(spawnPenumbra(['init'], sb.dir))).exitCode).toBe(0);
    daemon = spawnPenumbra(['start'], sb.dir);
    drainOutput(daemon);
    const port = await waitForPortFile(sb.dir, 5000);
    const token = readFileSync(join(sb.dir, 'token'), 'utf8').trim();
    prevEnv = { url: process.env.PENUMBRA_DAEMON_URL, token: process.env.PENUMBRA_DAEMON_TOKEN };
    process.env.PENUMBRA_DAEMON_URL = `http://127.0.0.1:${port}`;
    process.env.PENUMBRA_DAEMON_TOKEN = token;
  });

  afterEach(async () => {
    if (daemon) {
      await captureOutput(spawnPenumbra(['stop'], sb.dir));
      await killGracefully(daemon);
      daemon = null;
    }
    sb.cleanup();
    if (prevEnv.url === undefined) delete process.env.PENUMBRA_DAEMON_URL;
    else process.env.PENUMBRA_DAEMON_URL = prevEnv.url;
    if (prevEnv.token === undefined) delete process.env.PENUMBRA_DAEMON_TOKEN;
    else process.env.PENUMBRA_DAEMON_TOKEN = prevEnv.token;
  });

  test('one chat request produces two T0 rows in penumbra (agent-prompt + agent-response)', async () => {
    const m = await Test.createTestingModule({ imports: [IntegrationAppModule] }).compile();
    const app = m.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    try {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'x-penumbra-project': 'integration-test',
          'x-penumbra-user': 'integration-user',
        },
        payload: { model: 'fake-model', messages: [{ role: 'user', content: 'integration probe' }] },
      });
      expect(res.statusCode).toBe(201);

      // Bounded poll for the T0 rows.
      const dbPath = join(sb.dir, 'db.sqlite');
      let rows: { event_type: string; session_id: string | null; payload_summary: string | null; user_id: string }[] = [];
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const db = new Database(dbPath, { readonly: true });
        try {
          rows = db
            .query<{ event_type: string; session_id: string | null; payload_summary: string | null; user_id: string }, []>(
              "SELECT event_type, session_id, payload_summary, user_id FROM t0_events WHERE source = 'sirius-middleware' AND project_id = 'integration-test' ORDER BY ts ASC",
            )
            .all();
        } finally { db.close(); }
        if (rows.length >= 2) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(rows).toHaveLength(2);
      expect(rows[0]!.event_type).toBe('agent-prompt');
      expect(rows[1]!.event_type).toBe('agent-response');
      expect(rows[0]!.session_id).toEqual(rows[1]!.session_id);
      // The daemon normalises user_id to its own machine UUID (NormalizeCtx.userId = machineId.get());
      // the x-penumbra-user header is not stored verbatim in t0_events.user_id.
      expect(typeof rows[0]!.user_id).toBe('string');
      expect(rows[0]!.user_id.length).toBeGreaterThan(0);
      expect(rows[0]!.payload_summary).toBe('integration probe');
      expect(rows[1]!.payload_summary).toBe('integration ok');
    } finally { await app.close(); }
  });
});
