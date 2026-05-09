import { describe, test, expect } from 'bun:test';
import { spawn } from 'node:child_process';

function runScript(code: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['-e', code], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe('e2e harness', () => {
  test('starts, /health responds, stops cleanly', async () => {
    const script = `
      import { startE2EHarness } from './e2e/harness';
      const h = await startE2EHarness();
      try {
        const r = await Bun.fetch(h.baseUrl + '/health', { headers: { Authorization: 'Bearer ' + h.token } });
        if (r.status !== 200) throw new Error('status=' + r.status);
        const body = await r.json();
        if (body.status !== 'ok') throw new Error('health body mismatch');
      } finally {
        await h.stop();
      }
    `;
    const result = await runScript(script);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('rejects requests without bearer token', async () => {
    const script = `
      import { startE2EHarness } from './e2e/harness';
      const h = await startE2EHarness();
      try {
        const r = await Bun.fetch(h.baseUrl + '/health');
        if (r.status !== 401) throw new Error('status=' + r.status);
      } finally {
        await h.stop();
      }
    `;
    const result = await runScript(script);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('approve mutation removes the handoff from subsequent list calls', async () => {
    const script = `
      import { startE2EHarness } from './e2e/harness';
      const h = await startE2EHarness();
      h.addPendingHandoff({
        handoff_id: 'h-1',
        from_agent: 'a',
        to_agent: 'b',
        message: 'hi',
        ts: new Date().toISOString(),
      });
      const auth = { Authorization: 'Bearer ' + h.token };
      try {
        const r1 = await Bun.fetch(h.baseUrl + '/handoffs?status=pending', { headers: auth });
        const list1 = await r1.json();
        if (!Array.isArray(list1.handoffs) || list1.handoffs.length !== 1) throw new Error('initial list mismatch');

        const r2 = await Bun.fetch(h.baseUrl + '/handoffs/h-1/approve', { method: 'POST', headers: auth, body: '{}' });
        if (r2.status !== 200) throw new Error('approve status=' + r2.status);

        const r3 = await Bun.fetch(h.baseUrl + '/handoffs?status=pending', { headers: auth });
        const list3 = await r3.json();
        if (!Array.isArray(list3.handoffs) || list3.handoffs.length !== 0) throw new Error('final list mismatch');
      } finally {
        await h.stop();
      }
    `;
    const result = await runScript(script);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });
});
