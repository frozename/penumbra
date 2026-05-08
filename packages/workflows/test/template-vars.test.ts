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

test('resolves {{cwd}} and {{repo_root}}', () => {
  const ctxWithRepo = { ...ctx, cwd: '/repo/worktree', repoRoot: '/repo/root' };
  expect(resolveTemplateVars('c={{cwd}};r={{repo_root}}', ctxWithRepo)).toBe(
    'c=/repo/worktree;r=/repo/root',
  );
  expect(resolveTemplateVars('r={{repo_root}}', { ...ctx, cwd: '/repo/worktree' })).toBe(
    'r=/repo/worktree',
  );
});

test('leaves unknown tokens alone', () => {
  expect(resolveTemplateVars('{{unknown}}', ctx)).toBe('{{unknown}}');
});

test('resolves {{file_path}} when filePath is set, empty string otherwise', () => {
  expect(resolveTemplateVars('q={{file_path}}', ctx)).toBe('q=');
  const ctxWithFile: TemplateVarContext = { ...ctx, filePath: '/repo/src/foo.ts' };
  expect(resolveTemplateVars('q={{file_path}}', ctxWithFile)).toBe('q=/repo/src/foo.ts');
});

test('resolves {{args.*}} placeholders from template context args', () => {
  const ctxWithArgs: TemplateVarContext = {
    ...ctx,
    args: { base_ref: 'main', target_ref: 'HEAD', timeout_ms: 600000 },
  };
  expect(resolveTemplateVars('{{args.base_ref}}...{{args.target_ref}}', ctxWithArgs)).toBe('main...HEAD');
  expect(resolveTemplateVars('timeout={{args.timeout_ms}}', ctxWithArgs)).toBe('timeout=600000');
  expect(resolveTemplateVars('content={{args.content_path}}', ctxWithArgs)).toBe('content=');
});
