import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pluginRoot = join(process.cwd(), "plugin");
const commands = readdirSync(join(pluginRoot, "commands"))
  .filter((name) => name.endsWith(".md"))
  .map((name) => name.slice(0, -3));
const skills = readdirSync(join(pluginRoot, "skills"), { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() && existsSync(join(pluginRoot, "skills", entry.name, "SKILL.md")),
  )
  .map((entry) => entry.name);

describe("plugin skill/command namespace", () => {
  test("no command shadows a skill", () => {
    expect(commands.filter((command) => skills.includes(command))).toEqual([]);
  });

  test("penumbra:handoff serves the full protocol", () => {
    const body = readFileSync(join(pluginRoot, "skills/handoff/SKILL.md"), "utf8");
    for (const heading of ["## Step 1", "## Step 2", "## Step 3"]) expect(body).toContain(heading);
    expect(body).not.toContain(
      "Invoke the canonical handoff protocol via `Skill(penumbra:handoff)`",
    );
    expect(body).toMatch(/session-memory-sweep[\s\S]{0,400}cwd/);
  });

  test("/handoff and /penumbra:handoff both reach the full protocol", () => {
    const manifest = JSON.parse(
      readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"),
    ) as { name?: string };
    const skill = readFileSync(join(pluginRoot, "skills/handoff/SKILL.md"), "utf8");
    const playbook = readFileSync(
      join(pluginRoot, "playbooks/session-handoff/playbook.md"),
      "utf8",
    );
    const frontmatter = playbook.split("---")[1] ?? "";

    expect(manifest.name).toBe("penumbra");
    expect(skill).toMatch(/^---\nname: handoff\n/);
    expect(skill).toContain('mcp__penumbra__workflow_run({ "name": "session-handoff" })');
    const steps = ["## Step 1", "## Step 2", "## Step 3"].map((heading) => skill.indexOf(heading));
    expect(steps[0]).toBeGreaterThanOrEqual(0);
    expect(steps[1]).toBeGreaterThan(steps[0]!);
    expect(steps[2]).toBeGreaterThan(steps[1]!);
    expect(frontmatter).toMatch(/- kind: slash\n\s+command: handoff\n\s+skill: penumbra:handoff\n/);
  });
});
