import { expect, mock, test } from 'bun:test';
import { dispatchAuditHandler } from '../src/tools/dispatch-audit.js';

test('dispatchAuditHandler calls the daemon once with the supplied handoff_id', async () => {
  const calls: string[] = [];
  const daemon = {
    dispatchAudit: mock(async (handoff_id: string) => {
      calls.push(handoff_id);
      return {
        report: {
          handoff_id,
          status: 'complete',
          terminal: true,
          trustworthy: true,
          summary: 'dispatch lifecycle and result evidence are complete',
          missing_events: [],
          evidence: {
            handoff_status: 'completed',
            event_count: 4,
            response_count: 1,
            worktree_changed: true,
            reconciled: true,
            watchdog_failed: false,
            cancel_requested: false,
            adapter_streaming: true,
          },
          recommended_action: 'accept',
        },
      };
    }),
  } as const;

  const handler = dispatchAuditHandler(daemon as any);
  await handler({ handoff_id: 'h-1' });

  expect(daemon.dispatchAudit).toHaveBeenCalledTimes(1);
  expect(calls).toEqual(['h-1']);
});

test('dispatchAuditHandler wraps the daemon response in a text content envelope', async () => {
  const audit = {
    report: {
      handoff_id: 'h-1',
      status: 'complete',
      terminal: true,
      trustworthy: true,
      summary: 'dispatch lifecycle and result evidence are complete',
      missing_events: [],
      evidence: {
        handoff_status: 'completed',
        event_count: 4,
        response_count: 1,
        worktree_changed: true,
        reconciled: true,
        watchdog_failed: false,
        cancel_requested: false,
        adapter_streaming: true,
      },
      recommended_action: 'accept',
    },
  };
  const handler = dispatchAuditHandler({
    dispatchAudit: mock(async () => audit),
  } as any);

  const result = await handler({ handoff_id: 'h-1' });

  expect(result).toEqual({
    content: [{
      type: 'text',
      text: JSON.stringify(audit, null, 2),
    }],
  });
  expect(JSON.parse(result.content[0]!.text)).toEqual(audit);
});

test('dispatchAuditHandler propagates daemon errors', async () => {
  const handler = dispatchAuditHandler({
    dispatchAudit: mock(async () => {
      throw new Error('404 not found');
    }),
  } as any);

  await expect(handler({ handoff_id: 'missing-handoff' })).rejects.toThrow('404 not found');
});
