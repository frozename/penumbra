import { test, expect, mock } from 'bun:test';
import {
  refineDispatchPrompt,
  RefineError,
  REFINER_INPUT_MAX_BYTES,
  REFINER_OUTPUT_MAX_BYTES,
} from '../../src/services/dispatch-prompt-refiner.js';

test('refineDispatchPrompt happy path returns trimmed output', async () => {
  const chat = mock(async () => '  Reshaped prompt.  \n');
  const refined = await refineDispatchPrompt({ message: '# Spike\n\nDo X.', chat, model: 'gpt-4o' });
  expect(refined).toBe('Reshaped prompt.');
  expect(chat).toHaveBeenCalledTimes(1);
});

test('refineDispatchPrompt rejects input larger than REFINER_INPUT_MAX_BYTES', async () => {
  const chat = mock(async () => 'unused');
  const big = 'a'.repeat(REFINER_INPUT_MAX_BYTES + 1);
  await expect(refineDispatchPrompt({ message: big, chat, model: 'gpt-4o' })).rejects.toBeInstanceOf(RefineError);
  await expect(refineDispatchPrompt({ message: big, chat, model: 'gpt-4o' })).rejects.toMatchObject({
    code: 'input_too_large',
  });
  expect(chat).not.toHaveBeenCalled();
});

test('refineDispatchPrompt rejects blank input', async () => {
  const chat = mock(async () => 'unused');
  await expect(refineDispatchPrompt({ message: '   \n\t  ', chat, model: 'gpt-4o' })).rejects.toMatchObject({
    code: 'input_blank',
  });
  expect(chat).not.toHaveBeenCalled();
});

test('refineDispatchPrompt rejects empty refined output', async () => {
  const chat = mock(async () => '   \n  ');
  await expect(refineDispatchPrompt({ message: 'real input', chat, model: 'gpt-4o' })).rejects.toMatchObject({
    code: 'output_empty',
  });
});

test('refineDispatchPrompt rejects oversize refined output', async () => {
  const chat = mock(async () => 'a'.repeat(REFINER_OUTPUT_MAX_BYTES + 1));
  await expect(refineDispatchPrompt({ message: 'real input', chat, model: 'gpt-4o' })).rejects.toMatchObject({
    code: 'output_too_large',
  });
});

test('refineDispatchPrompt wraps upstream errors with upstream_failed code', async () => {
  const chat = mock(async () => { throw new Error('sirius down'); });
  await expect(refineDispatchPrompt({ message: 'real input', chat, model: 'gpt-4o' })).rejects.toMatchObject({
    code: 'upstream_failed',
    message: 'sirius down',
  });
});

test('refineDispatchPrompt passes system + user roles to chat fn', async () => {
  let captured: { role: string; content: string }[] | null = null;
  const chat = mock(async (opts: { messages: { role: string; content: string }[] }) => {
    captured = opts.messages;
    return 'ok';
  });
  await refineDispatchPrompt({ message: 'real input', chat, model: 'haiku-test' });
  expect(captured).not.toBeNull();
  expect(captured!.length).toBe(2);
  expect(captured![0].role).toBe('system');
  expect(captured![1]).toEqual({ role: 'user', content: 'real input' });
});
