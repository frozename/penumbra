import { expect, test } from 'bun:test';
import { resolveTemplateVars, type TemplateVarContext } from '../src/template-vars.js';

const ctx: TemplateVarContext = {
  now: () => new Date('2026-05-04T15:00:00Z'),
  project: 'penumbra',
  sessionStart: '2026-05-04T12:00:00Z',
  tz: 'America/Sao_Paulo',
};

test('resolves {{date}} and {{today}}', () => {
  expect(resolveTemplateVars('out-{{date}}.md', ctx)).toBe('out-2026-05-04.md');
  expect(resolveTemplateVars('{{today}}', ctx)).toBe('2026-05-04');
});

test('resolves {{period}} as am/pm based on local hour', () => {
  expect(resolveTemplateVars('{{period}}', ctx)).toBe('pm');
  const ctxAm: TemplateVarContext = { ...ctx, now: () => new Date('2026-05-04T11:00:00Z') };
  expect(resolveTemplateVars('{{period}}', ctxAm)).toBe('am');
});

test('resolves {{project}} and {{session_start}}', () => {
  expect(resolveTemplateVars('p={{project}};s={{session_start}}', ctx)).toBe(
    'p=penumbra;s=2026-05-04T12:00:00Z',
  );
});

test('leaves unknown tokens alone', () => {
  expect(resolveTemplateVars('{{unknown}}', ctx)).toBe('{{unknown}}');
});
