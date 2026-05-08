import { expect, test } from 'bun:test';
import {
  runPrOrphanSweep,
  type GhClient,
  type PrOrphanSweeperDeps,
} from '../../src/sweepers/pr-orphan-sweeper.js';

function makeDeps(overrides: Partial<PrOrphanSweeperDeps> = {}): {
  deps: PrOrphanSweeperDeps;
  events: Array<{ event_type: string; payload_json: any }>;
} {
  const t0: Array<{ event_type: string; payload_json: any }> = [];
  const deps: PrOrphanSweeperDeps = {
    clock: () => new Date('2026-05-08T12:00:00.000Z'),
    uuid: (() => {
      let i = 0;
      return () => `evt-${++i}`;
    })(),
    machineId: { get: () => 'machine-test' },
    t0Writer: {
      write: (row: any) => {
        t0.push({ event_type: row.event_type, payload_json: row.payload_json });
      },
    },
    log: {
      info: () => {},
      warn: () => {},
    },
    ghClient: {
      listOpenPullRequests: async () => [],
      closePullRequest: async () => {},
    },
    gitClient: {
      resolveMainSha: async () => 'main-sha-1',
      isAncestorOfMain: async () => false,
    },
    dryRun: false,
  };
  return { deps: { ...deps, ...overrides }, events: t0 };
}

function pr(partial: Partial<Awaited<ReturnType<GhClient['listOpenPullRequests']>>[number]> & { number: number; headRefName: string; headRefOid: string; updatedAt: string }) {
  return {
    title: 'agent dispatch',
    ...partial,
  };
}

test('superseded and stale agent PRs are closed with correct actions and t0 events', async () => {
  const closed: Array<{ number: number; comment: string; deleteBranch: boolean }> = [];
  const { deps, events } = makeDeps({
    ghClient: {
      listOpenPullRequests: async () => [
        pr({ number: 10, headRefName: 'agent/11111111-1111-1111-1111-111111111111', headRefOid: 'sha-sup', updatedAt: '2026-05-05T00:00:00.000Z' }),
        pr({ number: 11, headRefName: 'agent/22222222-2222-2222-2222-222222222222', headRefOid: 'sha-stale', updatedAt: '2026-04-28T00:00:00.000Z' }),
        pr({ number: 12, headRefName: 'agent/33333333-3333-3333-3333-333333333333', headRefOid: 'sha-active', updatedAt: '2026-05-07T00:00:00.000Z' }),
        pr({ number: 13, headRefName: 'feature/manual-pr', headRefOid: 'sha-manual', updatedAt: '2026-04-01T00:00:00.000Z' }),
      ],
      closePullRequest: async (input) => {
        closed.push(input);
      },
    },
    gitClient: {
      resolveMainSha: async () => 'main-sha-1',
      isAncestorOfMain: async (sha: string) => sha === 'sha-sup',
    },
  });

  const result = await runPrOrphanSweep(deps);

  expect(result.scanned).toBe(3);
  expect(result.superseded).toBe(1);
  expect(result.stale).toBe(1);
  expect(result.errored).toBe(0);
  expect(result.actions.map((a) => [a.pr_number, a.action, a.reason])).toEqual([
    [10, 'closed_and_deleted', 'superseded'],
    [11, 'closed', 'stale'],
  ]);
  expect(closed).toEqual([
    {
      number: 10,
      deleteBranch: true,
      comment: 'Superseded: head commit sha-sup is reachable from main as main-sha-1. Closing.',
    },
    {
      number: 11,
      deleteBranch: false,
      comment: 'Stale: no activity for 10 days; closing as abandoned. Reopen if needed.',
    },
  ]);
  expect(events.map((e) => e.payload_json.action)).toEqual(['closed_and_deleted', 'closed']);
});

test('dry-run mode emits events and report actions but does not close PRs', async () => {
  const closed: number[] = [];
  const { deps, events } = makeDeps({
    dryRun: true,
    ghClient: {
      listOpenPullRequests: async () => [
        pr({ number: 20, headRefName: 'agent/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', headRefOid: 'sha-sup', updatedAt: '2026-05-05T00:00:00.000Z' }),
        pr({ number: 21, headRefName: 'agent/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', headRefOid: 'sha-stale', updatedAt: '2026-04-20T00:00:00.000Z' }),
      ],
      closePullRequest: async (input) => {
        closed.push(input.number);
      },
    },
    gitClient: {
      resolveMainSha: async () => 'main-sha-2',
      isAncestorOfMain: async (sha: string) => sha === 'sha-sup',
    },
  });

  const result = await runPrOrphanSweep(deps);

  expect(closed).toEqual([]);
  expect(result.actions.map((a) => a.action)).toEqual(['dry_run_superseded', 'dry_run_stale']);
  expect(events.map((e) => e.payload_json.action)).toEqual(['dry_run_superseded', 'dry_run_stale']);
});

test('young PRs are not auto-closed even when superseded', async () => {
  const closed: number[] = [];
  const { deps } = makeDeps({
    ghClient: {
      listOpenPullRequests: async () => [
        pr({ number: 30, headRefName: 'agent/cccccccc-cccc-cccc-cccc-cccccccccccc', headRefOid: 'sha-sup', updatedAt: '2026-05-08T08:00:00.000Z' }),
      ],
      closePullRequest: async (input) => {
        closed.push(input.number);
      },
    },
    gitClient: {
      resolveMainSha: async () => 'main-sha-3',
      isAncestorOfMain: async () => true,
    },
  });

  const result = await runPrOrphanSweep(deps);
  expect(result.actions).toEqual([]);
  expect(closed).toEqual([]);
});

test('per-PR failures are isolated and counted as errored', async () => {
  const { deps } = makeDeps({
    ghClient: {
      listOpenPullRequests: async () => [
        pr({ number: 40, headRefName: 'agent/dddddddd-dddd-dddd-dddd-dddddddddddd', headRefOid: 'sha-sup-ok', updatedAt: '2026-05-04T00:00:00.000Z' }),
        pr({ number: 41, headRefName: 'agent/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', headRefOid: 'sha-sup-fail', updatedAt: '2026-05-04T00:00:00.000Z' }),
      ],
      closePullRequest: async (input) => {
        if (input.number === 41) throw new Error('gh failed');
      },
    },
    gitClient: {
      resolveMainSha: async () => 'main-sha-4',
      isAncestorOfMain: async () => true,
    },
  });

  const result = await runPrOrphanSweep(deps);
  expect(result.superseded).toBe(1);
  expect(result.errored).toBe(1);
});

test('maxClose limits actions during a manual sweep', async () => {
  const closed: number[] = [];
  const { deps } = makeDeps({
    ghClient: {
      listOpenPullRequests: async () => [
        pr({ number: 50, headRefName: 'agent/ffffffff-ffff-ffff-ffff-ffffffffffff', headRefOid: 'sha-sup', updatedAt: '2026-05-01T00:00:00.000Z' }),
        pr({ number: 51, headRefName: 'agent/99999999-9999-9999-9999-999999999999', headRefOid: 'sha-stale', updatedAt: '2026-04-20T00:00:00.000Z' }),
      ],
      closePullRequest: async (input) => {
        closed.push(input.number);
      },
    },
    gitClient: {
      resolveMainSha: async () => 'main-sha-5',
      isAncestorOfMain: async (sha: string) => sha === 'sha-sup',
    },
    maxClose: 1,
  });

  const result = await runPrOrphanSweep(deps);
  expect(result.actions.length).toBe(1);
  expect(closed.length).toBe(1);
});
