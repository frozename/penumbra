import { describe, it, expect, afterEach } from 'bun:test';
import { fsGrepHandler } from '../../src/tools/fs-grep.js';

function fakeDaemon(impl?: Partial<{ grepInWorktree: any }>): any {
  return { grepInWorktree: impl?.grepInWorktree ?? (async () => ({ results: [], truncated: false })) };
}

describe('fs.grep handler', () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it('forwards all relevant fields to daemon', async () => {
    let received: any = null;
    const daemon = fakeDaemon({
      grepInWorktree: async (id: string, args: any) => {
        received = { id, args };
        return { results: [], truncated: false };
      },
    });
    const handler = fsGrepHandler(daemon);
    await handler({ pattern: 'TODO', glob: '*.ts', output_mode: 'content', case_insensitive: true, handoff_id: 'H1' });
    expect(received.id).toBe('H1');
    expect(received.args).toMatchObject({ pattern: 'TODO', glob: '*.ts', output_mode: 'content', case_insensitive: true });
  });

  it('defaults handoff_id from env', async () => {
    process.env.PENUMBRA_HANDOFF_ID = 'H_ENV';
    let receivedId: string | null = null;
    const daemon = fakeDaemon({
      grepInWorktree: async (id: string) => {
        receivedId = id;
        return { results: [], truncated: false };
      },
    });
    const handler = fsGrepHandler(daemon);
    await handler({ pattern: 'TODO' });
    expect(receivedId).toBe('H_ENV');
  });

  it('returns no_handoff_context error when neither arg nor env set', async () => {
    const daemon = fakeDaemon();
    const handler = fsGrepHandler(daemon);
    const out = await handler({ pattern: 'TODO' });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe('no_handoff_context');
  });

  it('surfaces daemon engine_unavailable', async () => {
    const daemon = fakeDaemon({
      grepInWorktree: async () => {
        const err: any = new Error('daemon error');
        err.body = { error: { code: 'engine_unavailable', message: 'rg missing' } };
        throw err;
      },
    });
    const handler = fsGrepHandler(daemon);
    const out = await handler({ pattern: 'TODO', handoff_id: 'X' });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe('engine_unavailable');
  });
});
