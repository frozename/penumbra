import type { TemplateVarContext, WorkflowSpec } from "@penumbra/workflows";

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSessionHandoffTemplateCtx } from "@src/workflows/session-stamp.js";

function baseTemplateCtx(): TemplateVarContext {
  return {
    now: () => new Date("2026-05-01T00:00:00Z"),
    project: "penumbra",
    sessionStart: "2026-05-01T00:00:00.000Z",
    tz: "UTC",
    repoRoot: "/unused",
    sessionId: null,
  };
}

function workflowSpec(output: WorkflowSpec["output"]): WorkflowSpec {
  return {
    name: "session-handoff",
    description: "session handoff fixture",
    triggers: [],
    recall: [],
    output,
    run: { kind: "markdown-template" },
  };
}

test("session-handoff template context reuses the rendered skeleton sink when an earlier file sink is not a skeleton", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "session-stamp-"));
  try {
    const notesDir = join(repoRoot, "docs/notes");
    mkdirSync(notesDir, { recursive: true });
    const ignoredStamp = "123e4567-e89b-12d3-a456-426614174111";
    const skeletonStamp = "123e4567-e89b-12d3-a456-426614174222";
    writeFileSync(
      join(notesDir, "not-a-skeleton.md"),
      `<!-- penumbra:session ${ignoredStamp} -->\nignored\n`,
    );
    writeFileSync(
      join(notesDir, "maestro-continuation-2026-05-01-am.skeleton.md"),
      `<!-- penumbra:session ${skeletonStamp} -->\nskeleton\n`,
    );

    const result = resolveSessionHandoffTemplateCtx({
      spec: workflowSpec([
        { kind: "file", path: "docs/notes/not-a-skeleton.md" },
        { kind: "file", path: "docs/notes/maestro-continuation-{{date}}-{{period}}.skeleton.md" },
      ]),
      templateCtx: baseTemplateCtx(),
      repoRoot,
    });

    expect(result.sessionStamp).toBe(skeletonStamp);
    expect(result.templateCtx.sessionId).toBe(skeletonStamp);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("session-handoff template context leaves session id unset when no rendered file sink is a skeleton", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "session-stamp-"));
  try {
    mkdirSync(join(repoRoot, "docs/notes"), { recursive: true });
    writeFileSync(
      join(repoRoot, "docs/notes/not-a-skeleton.md"),
      "<!-- penumbra:session 123e4567-e89b-12d3-a456-426614174333 -->\nignored\n",
    );

    const result = resolveSessionHandoffTemplateCtx({
      spec: workflowSpec([{ kind: "file", path: "docs/notes/not-a-skeleton.md" }]),
      templateCtx: baseTemplateCtx(),
      repoRoot,
    });

    expect(result.sessionStamp).toBeNull();
    expect(result.templateCtx.sessionId).toBeNull();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
