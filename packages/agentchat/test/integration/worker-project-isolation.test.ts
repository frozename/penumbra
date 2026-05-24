import { expect, test } from 'bun:test';
import { startEventSource } from '../../src/worker/event-source.js';

const pollWaitMs = 60;

type ListHandoffsOpts = {
  statuses: string[];
  conversation_id?: string;
  project_id?: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stubClient(overrides: {
  listHandoffs: (opts: ListHandoffsOpts) => Promise<{ handoffs: any[] }>;
}) {
  return {
    listHandoffs: overrides.listHandoffs,
    subscribeHandoffEvents: async function* () {
      throw new Error('sse-disabled');
    },
  };
}

test('hard-isolated worker only keeps project-scoped claims', async () => {
  const calls: Array<ListHandoffsOpts> = [];
  const claimed: string[] = [];
  const rejected: string[] = [];
  const handoffs = [
    { handoff_id: 'alpha-1', status: 'approved', project_id: 'project-a' },
    { handoff_id: 'beta-1', status: 'approved', project_id: 'project-b' },
  ];

  const client = stubClient({
    listHandoffs: async (opts: ListHandoffsOpts) => {
      calls.push(opts);
      return { handoffs };
    },
  });

  const { stop } = startEventSource({
    client,
    statuses: ['approved'],
    project_id: 'project-a',
    isolation: 'hard',
    pollIntervalMs: 5,
    onEvent: (row) => {
      if (row.project_id === 'project-a') {
        claimed.push(row.handoff_id);
      } else {
        rejected.push(row.handoff_id);
      }
    },
  });

  await sleep(pollWaitMs);
  await stop();

  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0].project_id).toBe('project-a');
  expect(claimed).toContain('alpha-1');
  expect(rejected).toContain('beta-1');
});

test('sticky worker falls back to shared queue when project queue is empty', async () => {
  const calls: Array<ListHandoffsOpts> = [];
  const claimed: string[] = [];
  const projectRows: any[] = [];
  const sharedRows = [{ handoff_id: 'shared-1', status: 'approved', project_id: 'project-shared' }];

  const client = stubClient({
    listHandoffs: async (opts: ListHandoffsOpts) => {
      calls.push(opts);
      if (opts.project_id) return { handoffs: projectRows };
      return { handoffs: sharedRows };
    },
  });

  const { stop } = startEventSource({
    client,
    statuses: ['approved'],
    project_id: 'project-a',
    isolation: 'sticky',
    pollIntervalMs: 5,
    onEvent: (row) => {
      claimed.push(row.handoff_id);
    },
  });

  await sleep(pollWaitMs);
  await stop();

  expect(calls.some((call) => call.project_id === 'project-a')).toBe(true);
  expect(calls.some((call) => call.project_id === undefined)).toBe(true);
  expect(claimed).toEqual(['shared-1']);
});

test('shared worker polls without project filter and can claim any project', async () => {
  const calls: Array<ListHandoffsOpts> = [];
  const claimed: string[] = [];
  const handoffs = [
    { handoff_id: 'any-1', status: 'approved', project_id: 'project-a' },
    { handoff_id: 'any-2', status: 'approved', project_id: 'project-b' },
  ];

  const client = stubClient({
    listHandoffs: async (opts: ListHandoffsOpts) => {
      calls.push(opts);
      return { handoffs };
    },
  });

  const { stop } = startEventSource({
    client,
    statuses: ['approved'],
    project_id: 'project-a',
    isolation: 'shared',
    pollIntervalMs: 5,
    onEvent: (row) => {
      claimed.push(row.handoff_id);
    },
  });

  await sleep(pollWaitMs);
  await stop();

  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((call) => call.project_id === undefined)).toBe(true);
  expect(claimed.sort()).toEqual(['any-1', 'any-2']);
});

