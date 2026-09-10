import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const parseYaml = Bun.YAML.parse;

const packageRoot = resolve(fileURLToPath(new URL("../../plugin/codex/penumbra", import.meta.url)));
const requiredSkills = [
  "penumbra-memory",
  "penumbra-first-moves",
  "penumbra-workflow",
  "penumbra-plan",
  "penumbra-review",
  "penumbra-handoff",
  "penumbra-registrar",
  "penumbra-dispatch-evidence",
] as const;
const manifestKeys = new Set(["name", "version", "description", "author", "skills", "interface"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertContained(root: string, candidate: string): void {
  const canonicalRoot = realpathSync(root);
  const canonicalCandidate = realpathSync(candidate);
  const pathFromRoot = relative(canonicalRoot, canonicalCandidate);
  expect(isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith("../")).toBe(
    false,
  );
}

function discoverSkillFiles(skillsRoot: string): string[] {
  const discovered: string[] = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    const entryPath = resolve(skillsRoot, entry.name);
    assertContained(skillsRoot, entryPath);
    if (entry.isDirectory()) {
      discovered.push(...discoverSkillFiles(entryPath));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      discovered.push(entryPath);
    }
  }
  return discovered;
}

function relativeManifestPaths(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("./") ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(relativeManifestPaths);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(relativeManifestPaths);
}

function skillBody(skills: ReadonlyMap<string, string>, name: string): string {
  const body = skills.get(name);
  expect(body).toBeDefined();
  return body ?? "";
}

test("Codex package discovers skills only inside its dedicated root", () => {
  expect(existsSync(packageRoot), "Codex package root is missing").toBe(true);
  if (!existsSync(packageRoot)) return;

  const root = realpathSync(packageRoot);
  const manifestPath = resolve(root, ".codex-plugin/plugin.json");
  expect(existsSync(manifestPath), "Codex package manifest is missing").toBe(true);
  if (!existsSync(manifestPath)) return;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  expect(manifest.name).toBe("penumbra");
  expect(manifest.hooks).toBeUndefined();
  expect(manifest.mcpServers).toBeUndefined();
  expect(Object.keys(manifest).every((key) => manifestKeys.has(key))).toBe(true);

  for (const manifestPathValue of relativeManifestPaths(manifest)) {
    const referencedPath = resolve(root, manifestPathValue);
    expect(existsSync(referencedPath), `missing manifest path ${manifestPathValue}`).toBe(true);
    if (existsSync(referencedPath)) assertContained(root, referencedPath);
  }

  const skillsRootValue = manifest.skills;
  expect(typeof skillsRootValue).toBe("string");
  if (typeof skillsRootValue !== "string") return;
  expect(skillsRootValue.startsWith("./"), "skills path must be package-relative").toBe(true);
  expect(skillsRootValue).toBe("./skills/");
  const skillsRoot = resolve(root, skillsRootValue);
  expect(existsSync(skillsRoot), "Codex skills root is missing").toBe(true);
  if (!existsSync(skillsRoot)) return;
  assertContained(root, skillsRoot);

  const parentClaudeSkills = resolve(root, "../../skills");
  expect(realpathSync(skillsRoot)).not.toBe(realpathSync(parentClaudeSkills));

  const discovered = discoverSkillFiles(skillsRoot);
  expect(discovered.length).toBeGreaterThan(0);
  const skillBodies = new Map<string, string>();
  for (const skillPath of discovered) {
    assertContained(skillsRoot, skillPath);
    const source = readFileSync(skillPath, "utf8");
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    expect(frontmatter, `${skillPath} must begin with YAML frontmatter`).not.toBeNull();
    if (!frontmatter) continue;
    const frontmatterText = frontmatter[1];
    if (frontmatterText === undefined) continue;
    const metadata = parseYaml(frontmatterText);
    expect(isRecord(metadata), `${skillPath} frontmatter must be an object`).toBe(true);
    if (!isRecord(metadata)) continue;
    expect(typeof metadata.name).toBe("string");
    expect(typeof metadata.description).toBe("string");
    if (typeof metadata.name !== "string" || typeof metadata.description !== "string") continue;
    expect(metadata.name.trim()).not.toBe("");
    expect(metadata.description.trim()).not.toBe("");
    expect(skillBodies.has(metadata.name), `duplicate skill name ${metadata.name}`).toBe(false);
    expect(metadata.name).toBe(basename(dirname(skillPath)));
    skillBodies.set(metadata.name, source);
  }

  for (const requiredSkill of requiredSkills) expect(skillBodies.has(requiredSkill)).toBe(true);

  const packageText = [...skillBodies.values()].join("\n");
  for (const forbidden of [
    ".claude/workflows",
    "Workflow(",
    "agentType",
    "ultracode",
    "ctx.mcp",
    "dangerously-bypass-hook-trust",
  ]) {
    expect(packageText).not.toContain(forbidden);
  }
  expect(packageText).not.toMatch(/(?:api[_-]?key|secret|password|credential)\s*[:=]/i);
  expect(packageText).not.toMatch(/\/(?:Users|home)\/[A-Za-z0-9._-]+/);

  const workflow = skillBody(skillBodies, "penumbra-workflow");
  for (const requiredText of [
    "explicit absolute cwd",
    "workflow_list",
    "workflow_run",
    "workflow_wait",
    "timeout",
    "read_handle",
  ]) {
    expect(workflow).toContain(requiredText);
  }
  expect(skillBody(skillBodies, "penumbra-plan")).toContain(
    "Do not invoke implementation dispatch or landing.",
  );
  expect(skillBody(skillBodies, "penumbra-handoff")).toContain("Choose exactly one operation");
  const registrar = skillBody(skillBodies, "penumbra-registrar");
  expect(registrar).toContain("from_status");
  expect(registrar).toContain("ref_event_id");
});

test("Codex workflow skills distinguish discoverable workflows from their arguments", () => {
  const firstMoves = readFileSync(
    resolve(packageRoot, "skills/penumbra-first-moves/SKILL.md"),
    "utf8",
  );
  const review = readFileSync(resolve(packageRoot, "skills/penumbra-review/SKILL.md"), "utf8");
  const plan = readFileSync(resolve(packageRoot, "skills/penumbra-plan/SKILL.md"), "utf8");

  for (const skill of [firstMoves, review, plan]) {
    expect(skill).toContain(
      "`workflow_list` returns only a workflow's name, description, and triggers; it does not expose a per-workflow argument schema.",
    );
    expect(skill).toContain("Preserve explicit false and all supplied args.");
  }
  expect(firstMoves).toContain("`maestro-context-prime`");
  expect(firstMoves).toContain("`workflow_run`");
  expect(firstMoves).toContain("`wait: false`");
  expect(firstMoves).not.toContain("does not authorize a workflow run");
});
