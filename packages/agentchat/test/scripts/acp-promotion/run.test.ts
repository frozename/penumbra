import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAcpPromotion } from '../../../scripts/acp-promotion/run.js';

function configFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-promotion-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(
    path,
    `
agents:
  - name: gemini-acp-pro
    adapter: stdio-acp
    options: { binary: gemini, fsReadTextFile: true, fsWriteTextFile: true, terminal: true }
  - name: gemini
    adapter: gemini-cli
    options: { command: cat }
default_roles: {}
`,
  );
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('runAcpPromotion', () => {
  test('dry-run validates requested agents and does not dispatch', async () => {
    const cfg = configFile();
    try {
      const result = await runAcpPromotion({
        configPath: cfg.path,
        live: false,
        agents: ['gemini-acp-pro'],
        baselines: ['gemini'],
        scenarios: ['ping_exact'],
        now: () => '2026-05-02T00:00:00.000Z',
      });

      expect(result.rows).toEqual([
        expect.objectContaining({ agent: 'gemini-acp-pro', scenario: 'ping_exact', status: 'skipped' }),
        expect.objectContaining({ agent: 'gemini', scenario: 'ping_exact', status: 'skipped' }),
      ]);
    } finally {
      cfg.cleanup();
    }
  });

  test('live mode starts a chain and evaluates daemon evidence', async () => {
    const cfg = configFile();
    const calls: string[] = [];
    try {
      const result = await runAcpPromotion({
        configPath: cfg.path,
        live: true,
        agents: ['gemini-acp-pro'],
        baselines: [],
        scenarios: ['ping_exact'],
        now: () => '2026-05-02T00:00:00.000Z',
        pollIntervalMs: 1,
        client: {
          async startChain() {
            calls.push('startChain');
            return { handoff_id: 'h-live', conversation_id: 'c-live' };
          },
          async getHandoffStatus() {
            return {
              handoff_id: 'h-live',
              status: 'completed',
              error_summary: null,
              worker_id: 'w',
              started_at: '2026-05-02T00:00:00.000Z',
              resolved_at: '2026-05-02T00:00:05.000Z',
              latency_seconds: 5,
              reliability: { status: 'complete', trustworthy: true, recommended_action: 'accept', summary: 'ok' },
            };
          },
          async getChainResponses() {
            return { responses: [{ agent: 'gemini-acp-pro', text: 'ACP_PROMOTION_PING_OK\n', ts: '2026-05-02T00:00:05.000Z' }] };
          },
          async getDispatchTimeline() {
            return { events: [{ kind: 'acp.session.start' }, { kind: 'acp.session.end' }] };
          },
          async dispatchAudit() {
            return { report: { status: 'complete', trustworthy: true, recommended_action: 'accept' } };
          },
          async inspectWorktree() {
            return { worktree: { path: '/tmp/wt' }, diff_against_main: '', branch_log: '' };
          },
        },
      });

      expect(calls).toEqual(['startChain']);
      expect(result.rows[0]).toMatchObject({ agent: 'gemini-acp-pro', status: 'passed', handoff_id: 'h-live' });
    } finally {
      cfg.cleanup();
    }
  });
});
