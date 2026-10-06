import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRegistry } from "../src/registry.js";
import { writeSlashCommands } from "../src/slash-bridge.js";

const PB = (name: string, slash: string, skill?: string): string => `---
name: ${name}
description: D for ${name}
triggers:
  - kind: slash
    command: ${slash}
${skill === undefined ? "" : `    skill: ${skill}\n`}recall: []
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

test("skill-delegating slash trigger renders a Skill() command", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-"));
  const cmdDir = mkdtempSync(join(tmpdir(), "sbcmd-"));
  try {
    mkdirSync(join(root, "playbooks/h"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(join(root, "playbooks/h/playbook.md"), PB("h", "handoff", "penumbra:handoff"));
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    writeSlashCommands(reg, cmdDir);
    const body = readFileSync(join(cmdDir, "handoff.md"), "utf8");
    expect(body).toContain("Skill(penumbra:handoff)");
    expect(body).not.toContain("mcp__penumbra__workflow_run");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cmdDir, { recursive: true, force: true });
  }
});

test("skill-delegating slash trigger wins over a same-command workflow", async () => {
  for (const [skillName, plainName] of [
    ["a", "z"],
    ["z", "a"],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "sb-"));
    const cmdDir = mkdtempSync(join(tmpdir(), "sbcmd-"));
    try {
      mkdirSync(join(root, `playbooks/${skillName}`), { recursive: true });
      mkdirSync(join(root, `playbooks/${plainName}`), { recursive: true });
      mkdirSync(join(root, "workflows"), { recursive: true });
      writeFileSync(
        join(root, `playbooks/${skillName}/playbook.md`),
        PB(skillName!, "handoff", "penumbra:handoff"),
      );
      writeFileSync(join(root, `playbooks/${plainName}/playbook.md`), PB(plainName!, "handoff"));
      const reg = await buildRegistry({
        playbooksDir: join(root, "playbooks"),
        workflowsDir: join(root, "workflows"),
      });
      writeSlashCommands(reg, cmdDir);
      const body = readFileSync(join(cmdDir, "handoff.md"), "utf8");
      expect(body).toContain("Skill(penumbra:handoff)");
      expect(body).not.toContain("mcp__penumbra__workflow_run");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cmdDir, { recursive: true, force: true });
    }
  }
});

test("the real /handoff command reaches the penumbra:handoff skill", async () => {
  const repoRoot = join(import.meta.dir, "../../..");
  const root = mkdtempSync(join(repoRoot, ".slash-bridge-reg-"));
  const cmdDir = mkdtempSync(join(tmpdir(), "sbcmd-"));
  try {
    const playbookDir = join(root, "playbooks/session-handoff");
    const workflowDir = join(root, "workflows/session-handoff-draft");
    mkdirSync(playbookDir, { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    copyFileSync(
      join(repoRoot, "plugin/playbooks/session-handoff/playbook.md"),
      join(playbookDir, "playbook.md"),
    );
    copyFileSync(
      join(repoRoot, "plugin/workflows/session-handoff-draft/workflow.ts"),
      join(workflowDir, "workflow.ts"),
    );

    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    expect(reg.errors).toEqual([]);
    writeSlashCommands(reg, cmdDir);
    const body = readFileSync(join(cmdDir, "handoff.md"), "utf8");
    expect(body).toContain("Skill(penumbra:handoff)");
    expect(body).not.toContain("mcp__penumbra__workflow_run");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cmdDir, { recursive: true, force: true });
  }
});
