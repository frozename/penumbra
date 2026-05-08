import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../../core/src/db/sqlite-vec.js';
import { migrate } from '../../../core/src/db/migrations.js';
import { TaskWriter } from '../../../core/src/tasks/writer.js';
import { T0Writer } from '../../../core/src/writers/t0.js';
import type { GhClient } from '../../src/services/gh-client.js';
import { createGhTaskSyncService } from '../../src/sweepers/gh-task-sync.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function setup(): { db: Database; writer: TaskWriter; setNow: (ms: number) => void } {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let nowMs = Date.parse('2026-05-08T00:00:00.000Z');
  const writer = new TaskWriter(db, { now: () => nowMs });
  return {
    db,
    writer,
    setNow: (ms) => { nowMs = ms; },
  };
}

describe('gh-task-sync sweeper/service', () => {
  test('linked pending task + GH closed pulls to cancelled and writes t0 event', async () => {
    const { db, writer, setNow } = setup();
    const { task_id } = writer.file({
      prompt: 'sync me',
      created_by_kind: 'human',
      created_by_id: 'cli',
    });
    writer.linkGhIssue(task_id, { repo: 'acordeiro/penumbra', issue_number: 10 });

    const ghClient: GhClient = {
      viewIssue: async () => ({
        number: 10,
        state: 'CLOSED',
        stateReason: 'NOT_PLANNED',
        updatedAt: '2026-05-08T01:00:00.000Z',
        title: 'Issue 10',
        url: 'https://github.com/acordeiro/penumbra/issues/10',
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
    };

    setNow(Date.parse('2026-05-08T01:30:00.000Z'));
    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date('2026-05-08T01:30:00.000Z'),
      uuid: () => crypto.randomUUID(),
      userId: 'test-user',
      machineId: 'test-machine',
    });
    const out = await sync.syncLinkedTask(task_id);

    expect(out.action).toBe('pulled');
    expect(writer.get(task_id).status).toBe('cancelled');

    const event = db
      .query<{ event_type: string; payload_json: string }, []>(
        `SELECT event_type, payload_json
         FROM t0_events
         WHERE event_type = 'task.gh_state_pulled'
         ORDER BY ts DESC
         LIMIT 1`,
      )
      .get();
    expect(event?.event_type).toBe('task.gh_state_pulled');
    expect(JSON.parse(event?.payload_json ?? '{}').task_id).toBe(task_id);
  });

  test('linked done task newer than GH open pushes closeIssue(reason=completed)', async () => {
    const { db, writer, setNow } = setup();
    const { task_id } = writer.file({
      prompt: 'done task',
      created_by_kind: 'human',
      created_by_id: 'cli',
    });
    writer.linkGhIssue(task_id, { repo: 'acordeiro/penumbra', issue_number: 11 });

    setNow(Date.parse('2026-05-08T02:00:00.000Z'));
    db.run(`UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`, [Date.parse('2026-05-08T02:00:00.000Z'), task_id]);

    const closedCalls: Array<{ repo: string; issue: number; reason: 'completed' | 'not planned' }> = [];
    const ghClient: GhClient = {
      viewIssue: async () => ({
        number: 11,
        state: 'OPEN',
        stateReason: null,
        updatedAt: '2026-05-08T00:30:00.000Z',
        title: 'Issue 11',
        url: 'https://github.com/acordeiro/penumbra/issues/11',
      }),
      closeIssue: async (repo, issue, reason) => {
        closedCalls.push({ repo, issue, reason });
      },
      reopenIssue: async () => {},
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date('2026-05-08T02:05:00.000Z'),
      uuid: () => crypto.randomUUID(),
      userId: 'test-user',
      machineId: 'test-machine',
    });
    const out = await sync.syncLinkedTask(task_id);

    expect(out.action).toBe('pushed');
    expect(closedCalls).toEqual([
      { repo: 'acordeiro/penumbra', issue: 11, reason: 'completed' },
    ]);
  });

  test('syncAllLinkedTasks continues when one linked task errors', async () => {
    const { db, writer } = setup();
    const t1 = writer.file({ prompt: 't1', created_by_kind: 'human', created_by_id: 'cli' }).task_id;
    const t2 = writer.file({ prompt: 't2', created_by_kind: 'human', created_by_id: 'cli' }).task_id;
    const t3 = writer.file({ prompt: 't3', created_by_kind: 'human', created_by_id: 'cli' }).task_id;
    writer.linkGhIssue(t1, { repo: 'acordeiro/penumbra', issue_number: 21 });
    writer.linkGhIssue(t2, { repo: 'acordeiro/penumbra', issue_number: 22 });
    writer.linkGhIssue(t3, { repo: 'acordeiro/penumbra', issue_number: 23 });

    const viewed: number[] = [];
    const ghClient: GhClient = {
      viewIssue: async (_repo, issue) => {
        viewed.push(issue);
        if (issue === 22) throw new Error('network down');
        return {
          number: issue,
          state: 'OPEN',
          stateReason: null,
          updatedAt: '2026-05-08T00:00:00.000Z',
          title: `Issue ${issue}`,
          url: `https://github.com/acordeiro/penumbra/issues/${issue}`,
        };
      },
      closeIssue: async () => {},
      reopenIssue: async () => {},
    };

    const sync = createGhTaskSyncService({
      taskWriter: writer,
      ghClient,
      t0Writer: new T0Writer(db),
      now: () => new Date('2026-05-08T03:00:00.000Z'),
      uuid: () => crypto.randomUUID(),
      userId: 'test-user',
      machineId: 'test-machine',
    });
    const summary = await sync.syncAllLinkedTasks();

    expect(summary.linked).toBe(3);
    expect(summary.results).toHaveLength(3);
    expect(summary.errored).toBe(1);
    expect(new Set(viewed)).toEqual(new Set([21, 22, 23]));
  });
});
