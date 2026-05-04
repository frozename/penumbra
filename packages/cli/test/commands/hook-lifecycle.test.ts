import { expect, test } from 'bun:test';
import { runLifecycleForward } from '../../src/commands/hook.js';

test('runLifecycleForward calls forwardFn with kind=lifecycle and the given event', async () => {
  const calls: Array<{ event: string }> = [];
  const fakeForward = async (event: { kind: 'lifecycle'; event: string }) => {
    calls.push({ event: event.event });
  };
  await runLifecycleForward({ event: 'pre-compact', cwd: '/tmp', forwardFn: fakeForward });
  await runLifecycleForward({ event: 'stop', cwd: '/tmp', forwardFn: fakeForward });
  await runLifecycleForward({ event: 'session-start', cwd: '/tmp', forwardFn: fakeForward });
  expect(calls.map((c) => c.event)).toEqual(['pre-compact', 'stop', 'session-start']);
});
