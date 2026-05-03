import { describe, expect, it, mock } from 'bun:test';
import { shellListHandler } from '../../src/tools/shell-list.js';

describe('shellListHandler', () => {
  it('calls daemon.shellList with handoff_id and wraps the response', async () => {
    const sessions = [{ session_id: 's1', created_at: '2026-05-02T10:00:00.000Z', last_used_at: '2026-05-02T10:00:01.000Z', cwd: '/tmp', pty: false }];
    const daemon = { shellList: mock(async () => ({ sessions })) };
    const handler = shellListHandler(daemon as any);
    const result = await handler({ handoff_id: 'h-1' });
    expect(daemon.shellList).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text).sessions).toHaveLength(1);
  });
});
