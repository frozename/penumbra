import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export interface SkillFile {
  name: string;
  description: string;
  body: string;
  path: string;
}

export function loadSkillFiles(rootDir: string): SkillFile[] {
  const entries = readdirSync(rootDir);
  const skills: SkillFile[] = [];

  for (const entry of entries) {
    const dir = join(rootDir, entry);
    if (!statSync(dir).isDirectory()) continue;

    const path = join(dir, 'SKILL.md');
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }

    const text = readFileSync(path, 'utf8');
    const match = text.match(FRONTMATTER_RE);
    if (!match) {
      throw new Error(`skill ${path}: missing or malformed frontmatter`);
    }

    const fm = match[1];
    const body = match[2];
    const parsed = parseYaml(fm) as Record<string, unknown>;
    const name = parsed.name;
    const description = parsed.description;

    if (typeof name !== 'string') {
      throw new Error(`skill ${path}: missing or invalid name`);
    }
    if (typeof description !== 'string') {
      throw new Error(`skill ${path}: missing or invalid description`);
    }
    if (name !== entry) {
      throw new Error(`skill ${path}: frontmatter name "${name}" does not match directory "${entry}"`);
    }

    skills.push({
      name,
      description,
      body: body.trim(),
      path,
    });
  }

  return skills;
}
