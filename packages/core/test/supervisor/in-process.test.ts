import { expect, test } from 'bun:test';
import { InProcessSupervisor } from '../../src/supervisor/in-process.js';

test('start runs the tick function then reports running', async () => {
  const sup = new InProcessSupervisor();
  let count = 0;
  sup.register({
    name: 'w',
    intervalMs: 1_000,
    tick: async () => { count++; },
  });
  await sup.startAll();
  expect(sup.status('w')).toBe('running');
  await Bun.sleep(5); // let the initial tick run
  expect(count).toBeGreaterThanOrEqual(1);
  sup.stopAll();
});

test('stopAll stops ticks and reports stopped', async () => {
  const sup = new InProcessSupervisor();
  let count = 0;
  sup.register({ name: 'w', intervalMs: 1_000, tick: async () => { count++; } });
  await sup.startAll();
  sup.stopAll();
  expect(sup.status('w')).toBe('stopped');
});

test('thrown tick errors are caught; next tick still runs', async () => {
  const sup = new InProcessSupervisor();
  let throws = true;
  let ran = 0;
  sup.register({
    name: 'w', intervalMs: 5,
    tick: async () => {
      ran++;
      if (throws) { throws = false; throw new Error('boom'); }
    },
  });
  await sup.startAll();
  await Bun.sleep(30);
  sup.stopAll();
  expect(ran).toBeGreaterThanOrEqual(2);
});
