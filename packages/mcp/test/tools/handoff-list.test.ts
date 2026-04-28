import { expect, test } from 'bun:test';
import { listHandoffsHandler } from '../../src/tools/handoff-list.js';

test('listHandoffsHandler returns pending list as content', async () => {
  const fakeClient = {
    listPendingHandoffs: async () => ({ handoffs: [{ handoff_id: 'h-1', from_agent: 'a', to_agent: 'b', message: 'go', ts: 't', status: 'pending' }] }),
  };
  const handler = listHandoffsHandler(fakeClient as any);
  const result = await handler({});
  expect(result.content[0]!.type).toBe('text');
  expect(result.content[0]!.text).toMatch(/^[◌◐●◑] handoff_list_pending  /);
  expect(result.content[0]!.text).toContain('"handoff_id": "h-1"');
});
