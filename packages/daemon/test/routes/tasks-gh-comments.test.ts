import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../../core/src/db/sqlite-vec.js';
import { migrate } from '../../../core/src/db/migrations.js';
import { TaskWriter } from '../../../core/src/tasks/writer.js';
import { T0Writer } from '../../../core/src/writers/t0.js';
import type { GhClient } from '../../src/services/gh-client.js';
import { tasksCancelRoute } from '../../src/routes/tasks.js';
import { createGhTaskSyncService } from '../../src/sweepers/gh-task-sync.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

test('canceling a linked task posts a status_change comment to GitHub', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const writer = new TaskWriter(db, { now: () => Date.parse('2026-05-08T19:00:00.000Z') });
  const { task_id } = writer.file({
    prompt: 'cancel this task',
    created_by_kind: 'human',
    created_by_id: 'cli',
  });
  writer.linkGhIssue(task_id, { repo: 'acordeiro/penumbra', issue_number: 91 });

  const commentBodies: string[] = [];
  let viewCalls = 0;
  const ghClient: GhClient = {
    viewIssue: async () => {
      viewCalls += 1;
      return {
        number: 91,
        state: viewCalls === 1 ? 'OPEN' : 'CLOSED',
        stateReason: null,
        updatedAt: '2026-05-08T18:00:00.000Z',
        title: 'Issue 91',
        url: 'https://github.com/acordeiro/penumbra/issues/91',
      };
    },
    closeIssue: async () => {},
    reopenIssue: async () => {},
    commentIssue: async (_repo, _issueNumber, body) => {
      commentBodies.push(body);
      return { comment_url: 'https://github.com/acordeiro/penumbra/issues/91#issuecomment-777' };
    },
    listComments: async () => [],
  };

  const ghSync = createGhTaskSyncService({
    taskWriter: writer,
    ghClient,
    t0Writer: new T0Writer(db),
    now: () => new Date('2026-05-08T19:00:00.000Z'),
    uuid: () => crypto.randomUUID(),
  });

  const res = await tasksCancelRoute(
    new Request(`http://x/tasks/${task_id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'not needed' }),
    }),
    task_id,
    writer,
    ghSync,
  );

  expect(res.status).toBe(200);
  expect(commentBodies).toHaveLength(1);
  expect(commentBodies[0]).toContain('kind=status_change');
});
