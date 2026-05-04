import { expect, test } from 'bun:test';
import { renderTemplate } from '../src/template.js';

test('substitutes simple {{path}}', () => {
  expect(renderTemplate('hello {{name}}', { name: 'world' })).toBe('hello world');
});

test('substitutes nested path {{a.b.c}}', () => {
  expect(renderTemplate('{{a.b.c}}', { a: { b: { c: 'X' } } })).toBe('X');
});

test('renders {{#each}} array iteration', () => {
  const tpl = `{{#each items}}- {{name}}\n{{/each}}`;
  expect(renderTemplate(tpl, { items: [{ name: 'a' }, { name: 'b' }] })).toBe('- a\n- b\n');
});

test('renders {{#if}} when truthy', () => {
  const tpl = `{{#if has}}YES{{/if}}{{#if missing}}NO{{/if}}`;
  expect(renderTemplate(tpl, { has: true, missing: false })).toBe('YES');
});

test('leaves missing vars as empty string and pushes to warnings', () => {
  const warnings: string[] = [];
  expect(renderTemplate('{{missing}}', {}, { warnings })).toBe('');
  expect(warnings.length).toBe(1);
});

test('escapes nothing — output is plain text', () => {
  expect(renderTemplate('{{x}}', { x: '<html>' })).toBe('<html>');
});
