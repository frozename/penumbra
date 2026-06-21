import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export interface SkillFile {
  name: string;
  description: string;
  body: string;
  path: string;
}

function isSkillDir(rootDir: string, entry: string): string | null {
  const dir = join(rootDir, entry);
  if (!statSync(dir).isDirectory()) return null;
  const path = join(dir, "SKILL.md");
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return path;
}

function parseSkillFile(path: string, entry: string): SkillFile {
  const text = readFileSync(path, "utf8");
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    throw new Error(`skill ${path}: missing or malformed frontmatter`);
  }

  const fm = match[1] ?? "";
  const body = match[2] ?? "";
  const parsed = parseYaml(fm) as Record<string, unknown>;
  const name = parsed.name;
  const description = parsed.description;

  if (typeof name !== "string") {
    throw new Error(`skill ${path}: missing or invalid name`);
  }
  if (typeof description !== "string") {
    throw new Error(`skill ${path}: missing or invalid description`);
  }
  if (name !== entry) {
    throw new Error(
      `skill ${path}: frontmatter name "${name}" does not match directory "${entry}"`,
    );
  }

  return { name, description, body: body.trim(), path };
}

export function loadSkillFiles(rootDir: string): SkillFile[] {
  const entries = readdirSync(rootDir);
  const skills: SkillFile[] = [];

  for (const entry of entries) {
    const path = isSkillDir(rootDir, entry);
    if (!path) continue;
    skills.push(parseSkillFile(path, entry));
  }

  return skills;
}
