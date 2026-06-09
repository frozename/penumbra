import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const pluginRoot = join(repoRoot, "plugin");
const scannedFiles: string[] = [];
const ccProjectMemoryPath = [".claude", "projects"].join("/") + "/";

function collectFiles(dir: string, allowedSuffixes: string[]): void {
  if (!existsSync(dir)) {
    return;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, allowedSuffixes);
      continue;
    }

    if (allowedSuffixes.some((suffix) => fullPath.endsWith(suffix))) {
      scannedFiles.push(fullPath);
    }
  }
}

collectFiles(join(pluginRoot, "skills"), ["/SKILL.md"]);
collectFiles(join(pluginRoot, "commands"), [".md"]);
collectFiles(join(pluginRoot, "playbooks"), [".md"]);

function relative(path: string): string {
  return path.slice(repoRoot.length + 1);
}

describe("directive surfaces", () => {
  afterAll(() => {
    scannedFiles.length = 0;
  });

  test("plugin directives do not point at CC file-memory writes", () => {
    const failures: string[] = [];

    for (const file of scannedFiles) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (
          !line.includes(ccProjectMemoryPath) ||
          line.includes("derived") ||
          line.includes("read-only")
        ) {
          return;
        }

        if (new RegExp(`\\.${"claude"}/projects/.*/memory`).test(line)) {
          failures.push(`${relative(file)}:${index + 1}: ${line}`);
        }
      });
    }

    expect(failures).toEqual([]);
  });

  test("handoff skill Step 3 routes through memory_write_t2", () => {
    const lines = readFileSync(join(pluginRoot, "skills/handoff/SKILL.md"), "utf8").split(/\r?\n/);
    const step3Start = lines.findIndex((line) => line.includes("## Step 3"));
    expect(step3Start).toBeGreaterThanOrEqual(0);

    const step3Block = lines
      .slice(
        step3Start,
        lines.findIndex((line, index) => index > step3Start && line.startsWith("## ")) ||
          lines.length,
      )
      .join("\n");
    for (const token of ["memory_write_t2", "slug", "hook", "project_id"]) {
      expect(step3Block).toContain(token);
    }
  });
});
