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

  test('addChain returns via /chains?status=dispatched', async () => {
    const script = `
      import { startE2EHarness } from './e2e/harness';
      const h = await startE2EHarness();
      h.addChain({
        conversation_id: 'conv-1',
        project_id: null,
        latest_status: 'dispatched',
        latest_ts: new Date().toISOString(),
        earliest_ts: new Date().toISOString(),
        handoff_count: 3,
        root_handoff_id: 'root-h1',
        to_agent: 'claude',
        to_role: null,
        worktree_path: '/tmp/wt',
        worktree_root: null,
      });
      const auth = { Authorization: 'Bearer ' + h.token };
      try {
        const r = await Bun.fetch(h.baseUrl + '/chains?status=dispatched', { headers: auth });
        if (r.status !== 200) throw new Error('status=' + r.status);
        const body = await r.json();
        if (!Array.isArray(body.chains) || body.chains.length !== 1) throw new Error('chains mismatch');
        if (body.chains[0].conversation_id !== 'conv-1') throw new Error('conversation_id mismatch');
      } finally {
        await h.stop();
      }
    `;
    const result = await runScript(script);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('setPressure returns via /usage/subscription_pressure', async () => {
    const script = `
      import { startE2EHarness } from './e2e/harness';
      const h = await startE2EHarness();
      h.setPressure([{
        used_pct: 0.5,
        warn_pct: 0.8,
        refuse_pct: 0.95,
        provider: 'test-prov',
        model: 'test-model',
        window_label: '5m',
      }]);
      const auth = { Authorization: 'Bearer ' + h.token };
      try {
        const r = await Bun.fetch(h.baseUrl + '/usage/subscription_pressure', { headers: auth });
        if (r.status !== 200) throw new Error('status=' + r.status);
        const body = await r.json();
        if (!Array.isArray(body.windows) || body.windows.length !== 1) throw new Error('windows mismatch');
        if (body.windows[0].used_pct !== 0.5) throw new Error('used_pct mismatch');
      } finally {
        await h.stop();
      }
    `;
    const result = await runScript(script);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('injectError causes matching path to return error status, then clears', async () => {
    const script = `
      import { startE2EHarness } from './e2e/harness';
      const h = await startE2EHarness();
      const auth = { Authorization: 'Bearer ' + h.token };
      try {
        h.injectError('/health', 503);
        const r1 = await Bun.fetch(h.baseUrl + '/health', { headers: auth });
        if (r1.status !== 503) throw new Error('first call status=' + r1.status);

        const r2 = await Bun.fetch(h.baseUrl + '/health', { headers: auth });
        if (r2.status !== 200) throw new Error('second call status=' + r2.status);
      } finally {
        await h.stop();
      }
    `;
    const result = await runScript(script);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('pushEvent is callable without throwing', async () => {
    const script = `
      import { startE2EHarness } from './e2e/harness';
      const h = await startE2EHarness();
      try {
        h.pushEvent({ event: 'test', data: { kind: 'agent-prompt', ts: new Date().toISOString() } });
        h.pushEvent({ event: 'test', data: { kind: 'agent-response', ts: new Date().toISOString() } });
        if (typeof h.pushEvent !== 'function') throw new Error('pushEvent not a function');
      } finally {
        await h.stop();
      }
    `;
    const result = await runScript(script);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('setQuotaStatus customizes /usage/quota_status response', async () => {
    const script = `
      import { startE2EHarness } from './e2e/harness';
      const h = await startE2EHarness();
      h.setQuotaStatus({ dispatched_count: 4, cap: 10, subscription: { synth_total: 42 } });
      const auth = { Authorization: 'Bearer ' + h.token };
      try {
        const r = await Bun.fetch(h.baseUrl + '/usage/quota_status', { headers: auth });
        if (r.status !== 200) throw new Error('status=' + r.status);
        const body = await r.json();
        if (body.dispatched_count !== 4) throw new Error('dispatched_count=' + body.dispatched_count);
        if (body.cap !== 10) throw new Error('cap=' + body.cap);
        if (body.subscription.synth_total !== 42) throw new Error('synth_total=' + body.subscription.synth_total);
      } finally {
        await h.stop();
      }
    `;
    const result = await runScript(script);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });
});
