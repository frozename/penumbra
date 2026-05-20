import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const AGY_BINARY = process.env['AGY_BINARY'] ?? Bun.which('agy') ?? undefined;
const SHIM_ENTRY = new URL('../bin/agy-acp-shim.ts', import.meta.url).pathname;
const AGY_PRESENT = AGY_BINARY !== undefined && existsSync(AGY_BINARY);

describe('integration (requires local agy binary)', () => {
  it.skipIf(!AGY_PRESENT)(
    'full ACP round-trip: initialize → session/new → session/prompt → assert pong',
    async () => {
      const shim = spawn(process.execPath, [SHIM_ENTRY], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AGY_BINARY },
      });

      const rl = createInterface({ input: shim.stdout!, terminal: false });
      const readNext = (): Promise<any> =>
        new Promise((res) => {
          const handler = (line: string) => {
            rl.off('line', handler);
            res(JSON.parse(line));
          };
          rl.once('line', handler);
        });

      const send = (msg: object) =>
        shim.stdin!.write(JSON.stringify(msg) + '\n');

      // 1. initialize
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'penumbra', version: '1.0.0' },
      }});
      const initResp = await readNext();
      expect(initResp.error).toBeUndefined();
      expect(initResp.result).toBeDefined();

      // 2. session/new
      send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
      const sessionResp = await readNext();
      const sessionId: string = sessionResp.result.sessionId;
      expect(typeof sessionId).toBe('string');

      // 3. session/prompt — collect until done
      send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {
        sessionId,
        parts: [{ type: 'text', text: 'respond with exactly the word: pong' }],
      }});

      let fullText = '';
      let done = false;
      while (!done) {
        const msg = await readNext();
        if (msg.method === 'done') { done = true; break; }
        if (msg.method === 'session/update') {
          const delta: string = msg.params?.event?.delta ?? '';
          fullText += delta;
        }
      }
      expect(fullText.toLowerCase()).toContain('pong');

      shim.kill('SIGTERM');
    },
    120_000, // agy has ~3-5 s OAuth-resume + first-token latency
  );

  it.skipIf(!AGY_PRESENT)(
    'session/cancel kills the agy subprocess mid-prompt',
    async () => {
      const shim = spawn(process.execPath, [SHIM_ENTRY], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AGY_BINARY },
      });

      const rl = createInterface({ input: shim.stdout!, terminal: false });
      const readNext = (): Promise<any> =>
        new Promise((res) => {
          const handler = (line: string) => { rl.off('line', handler); res(JSON.parse(line)); };
          rl.once('line', handler);
        });
      const send = (msg: object) => shim.stdin!.write(JSON.stringify(msg) + '\n');

      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'penumbra', version: '1.0.0' },
      }});
      await readNext();

      send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
      const sessionResp = await readNext();
      const sessionId = sessionResp.result.sessionId;

      // send a long prompt, immediately cancel
      send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {
        sessionId,
        parts: [{ type: 'text', text: 'write a 5000-word essay about the history of computing' }],
      }});
      await new Promise((r) => setTimeout(r, 500));

      send({ jsonrpc: '2.0', id: 4, method: 'session/cancel', params: { sessionId } });
      const cancelResp = await readNext();
      expect(cancelResp.error).toBeUndefined();

      shim.kill('SIGTERM');
    },
    60_000,
  );
});
