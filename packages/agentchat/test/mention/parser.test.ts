import { expect, test } from 'bun:test';
import { parseMentions } from '../../src/mention/parser.js';

test('extracts a single @mention at the end of a message', () => {
  expect(parseMentions("Here's the plan. @gemini please run it."))
    .toEqual([{ target: 'gemini', span: { start: 17, end: 24 } }]);
});

test('extracts multiple @mentions', () => {
  expect(parseMentions('cc @gemini and @codex').map((m) => m.target))
    .toEqual(['gemini', 'codex']);
});

test('ignores @ inside an email or URL', () => {
  expect(parseMentions('contact alice@example.com or @bob'))
    .toEqual([{ target: 'bob', span: expect.any(Object) }]);
});

test('returns [] when there is no @mention', () => {
  expect(parseMentions('no targets here')).toEqual([]);
});

test('targets allow letters, digits, dashes, underscores', () => {
  expect(parseMentions('@local-llm and @gpt_4').map((m) => m.target))
    .toEqual(['local-llm', 'gpt_4']);
});
