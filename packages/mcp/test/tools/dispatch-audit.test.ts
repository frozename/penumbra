import { expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { DaemonClient } from '../../src/daemon-client.js';
import { DispatchAuditInputShape, dispatchAuditHandler } from '../../src/tools/dispatch-audit.js';
import { connectInMemory } from '../helpers.js';

test('DispatchAuditInputShape requires a handoff_id string', () => {
  const schema = z.object(DispatchAuditInputShape);
  expect(() => schema.parse({})).toThrow();
  expect(() => schema.parse({ handoff_id: '' })).toThrow();
  expect(schema.parse({ handoff_id: 'h-1' }).handoff_id).toBe('h-1');
});

test('dispatchAuditHandler delegates to the daemon and returns JSON text content', async () => {
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
  const daemon = {
    dispatchAudit: mock(async (handoff_id: string) => ({
      ...audit,
      report: { ...audit.report, handoff_id },
    })),
  } as any;

  const result = await dispatchAuditHandler(daemon)({ handoff_id: 'h-1' });

  expect(daemon.dispatchAudit).toHaveBeenCalledWith('h-1');
  expect(result.content[0].type).toBe('text');
  expect(JSON.parse(result.content[0].text)).toEqual(audit);
  expect(result.content[0].text).toContain('\n  "report"');
});

test('dispatch.audit is registered and forwards through DaemonClient to GET /dispatch/audit', async () => {
  let receivedMethod: string | undefined;
  let receivedPath: string | undefined;
  let receivedHandoffId: string | null = null;
  const audit = {
    report: {
      handoff_id: 'h space',
      status: 'no_agent_output',
      terminal: true,
      trustworthy: false,
      summary: 'terminal handoff has no agent response',
      missing_events: [],
      evidence: {
        handoff_status: 'completed',
        event_count: 4,
        response_count: 0,
        worktree_changed: null,
        reconciled: null,
        watchdog_failed: false,
        cancel_requested: false,
        adapter_streaming: null,
      },
      recommended_action: 'review_manually',
    },
  };
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      receivedMethod = req.method;
      receivedPath = url.pathname;
      receivedHandoffId = url.searchParams.get('handoff_id');
      return Response.json(audit);
    },
  });
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;

  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'dispatch.audit',
      arguments: { handoff_id: 'h space' },
    });
    const content = (out as unknown as { content: { type: string; text: string }[] }).content;

    expect(JSON.parse(content[0]!.text)).toEqual(audit);
    expect(receivedMethod).toBe('GET');
    expect(receivedPath).toBe('/dispatch/audit');
    expect(receivedHandoffId).toBe('h space');
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
