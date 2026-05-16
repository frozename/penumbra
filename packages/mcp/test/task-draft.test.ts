import { expect, test } from 'bun:test';
import { DaemonClient } from '../src/daemon-client.js';
import { taskDraftListPendingHandler } from '../src/tools/task-draft.js';

test('task_draft_list_pending forwards to daemon route', async () => {
  let received: unknown = null;
  const daemon = new DaemonClient({
    baseUrl: 'http://localhost:1234',
    token: 't',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    received = { method: init?.method ?? 'GET', path: url.pathname, search: url.search };
    return Response.json({ drafts: [{ event_id: 'e1' }] });
  }) as typeof fetch;
  try {
    const out = await taskDraftListPendingHandler(daemon)({
      latest_event_type: 'task_draft',
      project_id: 'p1',
      limit: 3,
    });
    expect(received).toEqual({
      method: 'GET',
      path: '/task-drafts/pending',
      search: '?latest_event_type=task_draft&project_id=p1&limit=3',
    });
    expect(JSON.parse((out as { content: { type: string; text: string }[] }).content[0]!.text)).toEqual({ drafts: [{ event_id: 'e1' }] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
