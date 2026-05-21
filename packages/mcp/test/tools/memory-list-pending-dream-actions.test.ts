import { beforeAll, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, applySchema } from '@penumbra/core';
import { listPendingDreamActionsQuery } from '../../../daemon/src/dreaming/digest.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded
}

beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

function openTestDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

function seedCycle(db: Database, cycleId: string): void {
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES(?, ?, 'cron', 1.0, 'completed', '[]')`,
  ).run(cycleId, Date.now());
}

function appendDreamAction(
  db: Database,
  opts: {
    cycleId?: string;
    phase: string;
    actionType: string;
    status: string;
    confidence: number;
    targetIds: string[];
    payload: object;
    untrustedSource: number;
  },
): void {
  const cycleId = opts.cycleId ?? 'cycle-default';
  // ensure cycle exists
  const exists = db.prepare(`SELECT 1 FROM dream_cycles WHERE cycle_id = ?`).get(cycleId);
  if (!exists) seedCycle(db, cycleId);

  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, untrusted_source)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    cycleId,
    opts.phase,
    opts.actionType,
    opts.confidence,
    opts.status,
    JSON.stringify(opts.targetIds),
    JSON.stringify(opts.payload),
    opts.untrustedSource,
  );
}

async function callTool(toolName: string, args: unknown, db: Database): Promise<any> {
  const { TOOL_REGISTRY } = await import('../../src/tools/registry');
  const fakeDaemon = {
    listPendingDreamActions: async (req: any) => listPendingDreamActionsQuery(db, req),
  } as any;
  const handler = TOOL_REGISTRY[toolName].makeHandler(fakeDaemon);
  const result = await handler(args) as any;
  return JSON.parse(result.content[0].text);
}

async function listRegisteredTools(): Promise<Array<{ name: string }>> {
  const { TOOL_REGISTRY } = await import('../../src/tools/registry');
  return Object.entries(TOOL_REGISTRY).map(([name]) => ({ name }));
}

it('tool name is memory_list_pending_dream_actions (not dream_pending_actions)', async () => {
  const tools = await listRegisteredTools();
  expect(tools.map((t) => t.name)).toContain('memory_list_pending_dream_actions');
  expect(tools.map((t) => t.name)).not.toContain('dream_pending_actions');
});

it('returns queued actions with untrusted_source and oldest_pending_age_hours', async () => {
  const db = openTestDb();
  appendDreamAction(db, {
    phase: 'P3',
    actionType: 'rewrite',
    status: 'queued',
    confidence: 0.7,
    targetIds: ['m1'],
    payload: {},
    untrustedSource: 0,
  });
  appendDreamAction(db, {
    phase: 'P5',
    actionType: 'mint_research',
    status: 'queued',
    confidence: 0.6,
    targetIds: ['m2'],
    payload: {},
    untrustedSource: 1,
  });
  const result = await callTool('memory_list_pending_dream_actions', { limit: 10 }, db);
  expect(result.actions).toHaveLength(2);
  const research = result.actions.find((a: any) => a.action_type === 'mint_research');
  expect(research.untrusted_source).toBe(1);
  expect(result.oldest_pending_age_hours).toBeGreaterThanOrEqual(0);
});

it('does NOT return auto_applied or rejected actions', async () => {
  const db = openTestDb();
  appendDreamAction(db, {
    phase: 'P2',
    actionType: 'link',
    status: 'auto_applied',
    confidence: 0.9,
    targetIds: ['m1'],
    payload: {},
    untrustedSource: 0,
  });
  const result = await callTool('memory_list_pending_dream_actions', {}, db);
  expect(result.actions).toHaveLength(0);
});
