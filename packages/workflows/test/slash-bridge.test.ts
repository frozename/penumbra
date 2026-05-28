import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "../src/registry.js";
import { writeSlashCommands } from "../src/slash-bridge.js";

const PB = (name: string, slash: string) => `---
name: ${name}
description: D for ${name}
triggers:
  - kind: slash
    command: ${slash}
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
body
`;

test("writes one .md per slash-trigger workflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-"));
  const cmdDir = mkdtempSync(join(tmpdir(), "sbcmd-"));
  try {
    mkdirSync(join(root, "playbooks/h"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(join(root, "playbooks/h/playbook.md"), PB("h", "handoff"));
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const written = writeSlashCommands(reg, cmdDir);
    expect(written).toEqual([join(cmdDir, "handoff.md")]);
    const body = readFileSync(join(cmdDir, "handoff.md"), "utf8");
    expect(body).toContain("mcp__penumbra__workflow_run");
    expect(body).toContain('"name": "h"');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cmdDir, { recursive: true, force: true });
  }
});

test("skips workflows without a slash trigger", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-"));
  const cmdDir = mkdtempSync(join(tmpdir(), "sbcmd-"));
  try {
    mkdirSync(join(root, "playbooks/m"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(
      join(root, "playbooks/m/playbook.md"),
      `---\nname: m\ndescription: D\ntriggers:\n  - kind: manual\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const written = writeSlashCommands(reg, cmdDir);
    expect(written).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cmdDir, { recursive: true, force: true });
  }
});
