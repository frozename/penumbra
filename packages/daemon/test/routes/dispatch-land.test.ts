import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { dispatchLandRoute, dispatchLandTaskRoute } from '../../src/routes/dispatch-land.js';
import { createDaemonFetchHandler } from '../../src/serve.js';

function services(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/dispatch-land-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-08T00:00:00.000Z'),
    uuid: () => `id-${++n}`,
  });
}

function seedHandoff(svc: Services, handoffId: string, conversationId: string): void {
  svc.handoffWriter.createApproved({
    handoff_id: handoffId,
    ts: '2026-05-08T00:00:00.000Z',
    project_id: null,
    conversation_id: conversationId,
    from: 'user',
    to: 'codex',
    to_role: null,
    message: `dispatch ${handoffId}`,
    triggered_by_event_id: `evt-${handoffId}`,
    resolved_by: 'chain-start',
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: 'implement_small',
    use_worktree: true,
    parent_handoff_id: null,
    branch_base: null,
    open_pr_on_review: false,
  });
}

function writeVerdictEvent(svc: Services, input: {
  eventId: string;
  ts: string;
  handoffId: string;
  conversationId: string;
  typecheck: 'pass' | 'fail';
  tests: 'pass' | 'fail';
}) {
  svc.t0Writer.write({
    event_id: input.eventId,
    ts: input.ts,
    ingest_ts: input.ts,
    source: 'agentchat',
    source_detail: 'merge-reconciler',
    project_id: null,
    user_id: 'local-user',
    machine_id: 'machine-1',
    session_id: input.conversationId,
    event_type: 'reconciler.verdict',
    lane: 'local',
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: {
      handoff_id: input.handoffId,
      conversation_id: input.conversationId,
      branch: `agent/${input.handoffId}`,
      typecheck: input.typecheck,
      tests: input.tests,
      files_changed: 3,
      lines_added: 30,
      lines_deleted: 10,
      summary: `${input.typecheck}/${input.tests}`,
    },
    payload_summary: `${input.typecheck}/${input.tests}`,
  });
}

async function waitForLandTask(
  svc: Services,
  taskId: string,
): Promise<any> {
  for (let i = 0; i < 30; i += 1) {
    const res = await dispatchLandTaskRoute(
      new Request(`http://x/dispatch/land/${taskId}`),
      svc,
      taskId,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    if (body.status === 'done' || body.status === 'failed') return body;
    await Bun.sleep(5);
  }
  throw new Error(`task ${taskId} did not finish`);
}

describe('dispatchLandRoute', () => {
  test('serve.ts wires authenticated POST /dispatch/land', async () => {
    const svc = services();
    const handler = createDaemonFetchHandler({ services: svc, token: 'tok' });
    const res = await handler(new Request('http://x/dispatch/land', {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        handoff_id: 'missing',
        commit_message: 'chore: test wire',
      }),
    }));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('not_found');
  });

  test('returns 202 with task_id and exposes terminal status via GET /dispatch/land/:task_id', async () => {
    const svc = services();
    seedHandoff(svc, 'h-async-1', 'c-async-1');
    writeVerdictEvent(svc, {
      eventId: 'v-async-1',
      ts: '2026-05-08T00:01:00.000Z',
      handoffId: 'h-async-1',
      conversationId: 'c-async-1',
      typecheck: 'pass',
      tests: 'pass',
    });

    let revParseCount = 0;
    const post = await dispatchLandRoute(
      new Request('http://x/dispatch/land', {
        method: 'POST',
        body: JSON.stringify({
          handoff_id: 'h-async-1',
          commit_message: 'feat(core): async land',
          mode: 'squash',
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === 'rev-parse') {
            revParseCount += 1;
            return { code: 0, stdout: revParseCount === 1 ? 'base-main\n' : 'new-main\n', stderr: '' };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
        now: () => new Date('2026-05-08T00:04:00.000Z'),
      } as any,
    );

    expect(post.status).toBe(202);
    const accepted = await post.json() as any;
    expect(accepted.task_id).toBeDefined();
    expect(accepted.status).toBe('queued');

    const terminal = await waitForLandTask(svc, accepted.task_id);
    expect(terminal.status).toBe('done');
    expect(terminal.result).toMatchObject({
      ok: true,
      commit_sha: 'new-main',
      message_subject: 'feat(core): async land',
      branch_deleted: false,
      pr_closed: false,
    });
  });

  test('squash mode lands with curated message, emits event, deletes branch, and closes open PR', async () => {
    const svc = services();
    seedHandoff(svc, 'h-1', 'c-1');
    writeVerdictEvent(svc, {
      eventId: 'v-1',
      ts: '2026-05-08T00:01:00.000Z',
      handoffId: 'h-1',
      conversationId: 'c-1',
      typecheck: 'pass',
      tests: 'pass',
    });

    const gitCalls: Array<{ args: string[]; stdin?: string }> = [];
    let revParseCount = 0;
    const deps = {
      runGit: async (args: string[], opts?: { stdin?: string }) => {
        gitCalls.push({ args, stdin: opts?.stdin });
        if (args[0] === 'rev-parse' && args[1] === 'main') {
          revParseCount += 1;
          return { code: 0, stdout: revParseCount === 1 ? 'old-main\n' : 'new-main\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      gh: {
        listOpenPullRequestsByHead: async (head: string) => {
          if (head !== 'agent/h-1') throw new Error(`unexpected head ${head}`);
          return [{ number: 77 }];
        },
        closePullRequest: async () => {},
      },
      now: () => new Date('2026-05-08T00:02:00.000Z'),
    };

    const res = await dispatchLandRoute(
      new Request('http://x/dispatch/land', {
        method: 'POST',
        body: JSON.stringify({
          handoff_id: 'h-1',
          commit_message: 'feat(core): curated subject\n\nbody details',
          mode: 'squash',
          delete_branch: true,
        }),
      }),
      svc,
      deps as any,
    );

    expect(res.status).toBe(202);
    const accepted = await res.json() as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe('done');
    expect(body.result.ok).toBe(true);
    expect(body.result.commit_sha).toBe('new-main');
    expect(body.result.message_subject).toBe('feat(core): curated subject');
    expect(body.result.branch_deleted).toBe(true);
    expect(body.result.pr_closed).toBe(true);

    expect(gitCalls.map((c) => c.args.join(' '))).toEqual([
      'rev-parse main',
      'checkout main',
      'merge --squash agent/h-1',
      'commit -F -',
      'rev-parse main',
      'branch -D agent/h-1',
    ]);
    expect(gitCalls[3]?.stdin).toBe('feat(core): curated subject\n\nbody details');

    const landed = svc.db
      .query<{ event_type: string; payload_json: string }, []>(
        `SELECT event_type, payload_json FROM t0_events WHERE event_type='dispatch.landed' ORDER BY ts DESC LIMIT 1`,
      )
      .get();
    expect(landed?.event_type).toBe('dispatch.landed');
    const payload = JSON.parse(landed?.payload_json ?? '{}');
    expect(payload).toMatchObject({
      handoff_id: 'h-1',
      conversation_id: 'c-1',
      mode: 'squash',
      commit_sha: 'new-main',
      branch: 'agent/h-1',
      message_subject: 'feat(core): curated subject',
    });
  });

  test('ff mode runs ff-only merge and leaves branch when delete_branch=false', async () => {
    const svc = services();
    seedHandoff(svc, 'h-2', 'c-2');
    writeVerdictEvent(svc, {
      eventId: 'v-2',
      ts: '2026-05-08T00:01:00.000Z',
      handoffId: 'h-2',
      conversationId: 'c-2',
      typecheck: 'pass',
      tests: 'pass',
    });

    const gitCalls: Array<string> = [];
    let revParseCount = 0;
    const res = await dispatchLandRoute(
      new Request('http://x/dispatch/land', {
        method: 'POST',
        body: JSON.stringify({
          handoff_id: 'h-2',
          commit_message: 'chore: ignored by ff',
          mode: 'ff',
          delete_branch: false,
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          gitCalls.push(args.join(' '));
          if (args[0] === 'rev-parse') {
            revParseCount += 1;
            return { code: 0, stdout: revParseCount === 1 ? 'base-main\n' : 'ff-main\n', stderr: '' };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
        now: () => new Date('2026-05-08T00:03:00.000Z'),
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = await res.json() as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe('done');
    expect(body.result.commit_sha).toBe('ff-main');
    expect(body.result.branch_deleted).toBe(false);
    expect(body.result.pr_closed).toBe(false);
    expect(gitCalls).toEqual([
      'rev-parse main',
      'merge --ff-only agent/h-2',
      'rev-parse main',
    ]);
  });

  test('returns 409 verdict_unverified when reconciler verdict failed', async () => {
    const svc = services();
    seedHandoff(svc, 'h-3', 'c-3');
    writeVerdictEvent(svc, {
      eventId: 'v-3',
      ts: '2026-05-08T00:01:00.000Z',
      handoffId: 'h-3',
      conversationId: 'c-3',
      typecheck: 'pass',
      tests: 'fail',
    });

    let called = false;
    const res = await dispatchLandRoute(
      new Request('http://x/dispatch/land', {
        method: 'POST',
        body: JSON.stringify({
          handoff_id: 'h-3',
          commit_message: 'feat: should not land',
        }),
      }),
      svc,
      {
        runGit: async () => {
          called = true;
          return { code: 0, stdout: '', stderr: '' };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
      } as any,
    );

    expect(res.status).toBe(409);
    expect(called).toBe(false);
    const body = await res.json() as any;
    expect(body.error.code).toBe('verdict_unverified');
    expect(body.error.verdict.tests).toBe('fail');
  });

  test('returns 409 merge_conflict with conflicted files and aborts merge', async () => {
    const svc = services();
    seedHandoff(svc, 'h-4', 'c-4');
    writeVerdictEvent(svc, {
      eventId: 'v-4',
      ts: '2026-05-08T00:01:00.000Z',
      handoffId: 'h-4',
      conversationId: 'c-4',
      typecheck: 'pass',
      tests: 'pass',
    });

    const gitCalls: Array<string> = [];
    const res = await dispatchLandRoute(
      new Request('http://x/dispatch/land', {
        method: 'POST',
        body: JSON.stringify({
          handoff_id: 'h-4',
          commit_message: 'feat: conflict',
          mode: 'squash',
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          const cmd = args.join(' ');
          gitCalls.push(cmd);
          if (cmd === 'rev-parse main') return { code: 0, stdout: 'main-before\n', stderr: '' };
          if (cmd === 'checkout main') return { code: 0, stdout: '', stderr: '' };
          if (cmd === 'merge --squash agent/h-4') return { code: 1, stdout: '', stderr: 'CONFLICT (content)' };
          if (cmd === 'diff --name-only --diff-filter=U') return { code: 0, stdout: 'a.txt\nb.ts\n', stderr: '' };
          if (cmd === 'merge --abort') return { code: 0, stdout: '', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = await res.json() as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe('failed');
    expect(body.error.code).toBe('merge_conflict');
    expect(body.error.files).toEqual(['a.txt', 'b.ts']);
    expect(gitCalls).toEqual([
      'rev-parse main',
      'checkout main',
      'merge --squash agent/h-4',
      'diff --name-only --diff-filter=U',
      'merge --abort',
    ]);
  });

  test('returns 409 merge_conflict with files from reconciler verdict when rebase_result=conflict', async () => {
    const svc = services();
    seedHandoff(svc, 'h-4b', 'c-4b');
    svc.t0Writer.write({
      event_id: 'v-4b',
      ts: '2026-05-08T00:01:00.000Z',
      ingest_ts: '2026-05-08T00:01:00.000Z',
      source: 'agentchat',
      source_detail: 'merge-reconciler',
      project_id: null,
      user_id: 'local-user',
      machine_id: 'machine-1',
      session_id: 'c-4b',
      event_type: 'reconciler.verdict',
      lane: 'local',
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      request_id: null,
      payload_json: {
        handoff_id: 'h-4b',
        conversation_id: 'c-4b',
        branch: 'agent/h-4b',
        typecheck: 'pass',
        tests: 'pass',
        files_changed: 1,
        lines_added: 1,
        lines_deleted: 0,
        ff_mergeable: false,
        rebase_required: true,
        rebase_attempted: true,
        rebase_result: 'conflict',
        rebase_conflict_files: ['packages/core/src/a.ts', 'packages/daemon/src/b.ts'],
        summary: 'rebase conflict',
      },
      payload_summary: 'rebase conflict',
    });

    let called = false;
    const res = await dispatchLandRoute(
      new Request('http://x/dispatch/land', {
        method: 'POST',
        body: JSON.stringify({
          handoff_id: 'h-4b',
          commit_message: 'feat: conflict',
          mode: 'squash',
        }),
      }),
      svc,
      {
        runGit: async () => {
          called = true;
          return { code: 0, stdout: '', stderr: '' };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async () => {},
        },
      } as any,
    );

    expect(res.status).toBe(409);
    expect(called).toBe(false);
    const body = await res.json() as any;
    expect(body.error.code).toBe('merge_conflict');
    expect(body.error.files).toEqual(['packages/core/src/a.ts', 'packages/daemon/src/b.ts']);
  });

  test('is silent about PR close when branch has no open PR', async () => {
    const svc = services();
    seedHandoff(svc, 'h-5', 'c-5');
    writeVerdictEvent(svc, {
      eventId: 'v-5',
      ts: '2026-05-08T00:01:00.000Z',
      handoffId: 'h-5',
      conversationId: 'c-5',
      typecheck: 'pass',
      tests: 'pass',
    });

    const closed: number[] = [];
    const res = await dispatchLandRoute(
      new Request('http://x/dispatch/land', {
        method: 'POST',
        body: JSON.stringify({
          handoff_id: 'h-5',
          commit_message: 'feat: no pr',
        }),
      }),
      svc,
      {
        runGit: async (args: string[]) => {
          if (args[0] === 'rev-parse') return { code: 0, stdout: 'same-main\n', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
        gh: {
          listOpenPullRequestsByHead: async () => [],
          closePullRequest: async (number: number) => { closed.push(number); },
        },
        now: () => new Date('2026-05-08T00:04:00.000Z'),
      } as any,
    );

    expect(res.status).toBe(202);
    const accepted = await res.json() as any;
    const body = await waitForLandTask(svc, accepted.task_id);
    expect(body.status).toBe('done');
    expect(body.result.pr_closed).toBe(false);
    expect(closed).toEqual([]);
  });
});
