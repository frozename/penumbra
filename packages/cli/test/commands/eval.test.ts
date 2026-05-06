import { expect, test } from 'bun:test';
import { dispatchEvalSubcommand } from '../../src/commands/eval.ts';

test('dispatchEvalSubcommand rejects missing model for run', async () => {
  const code = await dispatchEvalSubcommand(['run']);
  expect(code).toBe(2);
});
