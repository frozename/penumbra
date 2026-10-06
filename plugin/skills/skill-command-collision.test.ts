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
});
