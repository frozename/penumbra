import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMarkdownPlaybook } from '../../src/loaders/markdown.js';

const FIXTURE = `---
name: example
description: A demo playbook
triggers:
  - kind: slash
    command: example
recall:
  - source: memory_search
    args:
      query: hello
output:
  - kind: file
    path: out.md
run:
  kind: markdown-template
---
# Example

Body line 1
Body line 2 — {{recall.memory_search}}
`;

test('parses frontmatter and lifts body into run.template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-'));
  try {
    const path = join(dir, 'playbook.md');
    writeFileSync(path, FIXTURE);
    const spec = loadMarkdownPlaybook(path);
    expect(spec.name).toBe('example');
    expect(spec.run.kind).toBe('markdown-template');
    if (spec.run.kind === 'markdown-template') {
      expect(spec.run.template).toContain('# Example');
      expect(spec.run.template).toContain('{{recall.memory_search}}');
      expect(spec.run.template).not.toContain('---'); // frontmatter stripped
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws on missing frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-'));
  try {
    const path = join(dir, 'playbook.md');
    writeFileSync(path, '# Just a body\n\nNo frontmatter');
    expect(() => loadMarkdownPlaybook(path)).toThrow(/frontmatter/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws on invalid YAML in frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-'));
  try {
    const path = join(dir, 'playbook.md');
    writeFileSync(path, '---\nname: x\n  bad: indent\n---\nbody');
    expect(() => loadMarkdownPlaybook(path)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
