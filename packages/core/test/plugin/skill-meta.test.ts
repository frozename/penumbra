import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillFiles } from '../../src/plugin/skill-meta';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

test('loads a valid skill file', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-meta-'));
  dirs.push(root);

  const skillDir = join(root, 'foo');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: foo',
      'description: Test skill',
      '---',
      '',
      '# Foo',
      '',
      'Skill body.',
      '',
    ].join('\n'),
  );

  const files = loadSkillFiles(root);

  expect(files).toHaveLength(1);
  expect(files[0]).toEqual({
    name: 'foo',
    description: 'Test skill',
    body: '# Foo\n\nSkill body.',
    path: join(skillDir, 'SKILL.md'),
  });
});

test('throws when description is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-meta-'));
  dirs.push(root);

  const skillDir = join(root, 'foo');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    ['---', 'name: foo', '---', '', '# Foo', ''].join('\n'),
  );

  expect(() => loadSkillFiles(root)).toThrowError(
    `skill ${join(skillDir, 'SKILL.md')}: missing or invalid description`,
  );
});

test('throws when directory name and frontmatter name mismatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-meta-'));
  dirs.push(root);

  const skillDir = join(root, 'foo-bar');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    ['---', 'name: foo', 'description: Test skill', '---', '', '# Foo', ''].join('\n'),
  );

  expect(() => loadSkillFiles(root)).toThrowError(
    `skill ${join(skillDir, 'SKILL.md')}: frontmatter name "foo" does not match directory "foo-bar"`,
  );
});
