import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitNextSessionPromptOutput } from "@src/outputs/next-session-prompt.js";
import {
  type PendingHandoffOutput,
  runPendingHandoffSource,
} from "@src/recall-sources/pending-handoff.js";

const NOW = new Date("2026-09-21T16:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function withStorageRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pending-handoff-source-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function emit(
  root: string,
  opts: { project: string; workflowName: string; body: string; at?: Date },
): Promise<void> {
  const r = await emitNextSessionPromptOutput({
    body: opts.body,
    storageRoot: root,
    workflowName: opts.workflowName,
    project: opts.project,
    now: () => opts.at ?? NOW,
  });
  expect(r.warnings).toEqual([]);
}

function read(
  root: string | undefined,
  project: string,
  args: Record<string, unknown> = {},
): Promise<PendingHandoffOutput> {
  return runPendingHandoffSource({ storageRoot: root, project, now: () => NOW, args });
}

test("each project's session sees only its own sections", async () => {
  await withStorageRoot(async (root) => {
    await emit(root, {
      project: "alpha",
      workflowName: "session-handoff-stop",
      body: "ALPHA_STOP",
    });
    await emit(root, { project: "beta", workflowName: "session-handoff-stop", body: "BETA_STOP" });
    await emit(root, { project: "beta", workflowName: "session-memory-sweep", body: "BETA_SWEEP" });

    const alpha = await read(root, "alpha");
    const beta = await read(root, "beta");

    expect(alpha.result.body).toContain("ALPHA_STOP");
    expect(alpha.result.body).not.toContain("BETA");
    expect(beta.result.body).toContain("BETA_STOP");
    expect(beta.result.body).toContain("BETA_SWEEP");
    expect(beta.result.body).not.toContain("ALPHA");
  });
});

test("a single project keeps every workflow's section in write order, without fence markup", async () => {
  await withStorageRoot(async (root) => {
    await emit(root, { project: "alpha", workflowName: "session-handoff-stop", body: "STOP v1" });
    await emit(root, { project: "alpha", workflowName: "session-memory-sweep", body: "SWEEP v1" });
    await emit(root, { project: "alpha", workflowName: "session-handoff-stop", body: "STOP v2" });

    const out = await read(root, "alpha");

    expect(out.result.path).toBe(join(root, "pending-handoff.alpha.md"));
    expect(out.result.body).toBe("STOP v2\n\nSWEEP v1");
    expect(out.result.truncated).toBe(false);
    expect(out.warnings).toEqual([]);
  });
});

test("the legacy global pending-handoff.md is never surfaced, fenced or not", async () => {
  await withStorageRoot(async (root) => {
    writeFileSync(
      join(root, "pending-handoff.md"),
      [
        "# PENUMBRA continuation 2026-09-09",
        "## First moves",
        "1. bounce the daemon",
        "<!-- penumbra:section session-handoff-stop -->",
        "LEGACY_FENCED_CHECKPOINT",
        "<!-- /penumbra:section session-handoff-stop -->",
        "",
      ].join("\n"),
    );

    const out = await read(root, "alpha");

    expect(out.result.body).toBe("");
    expect(out.warnings).toEqual([]);
  });
});

test("unfenced text in the project's own file is dropped", async () => {
  await withStorageRoot(async (root) => {
    await emit(root, { project: "alpha", workflowName: "session-handoff-stop", body: "FENCED" });
    const target = join(root, "pending-handoff.alpha.md");
    const fenced = await Bun.file(target).text();
    writeFileSync(target, `HAND_WRITTEN_HEAD\n## First moves\n1. do it\n${fenced}TRAILING_NOTE\n`);

    const out = await read(root, "alpha");

    expect(out.result.body).toBe("FENCED");
  });
});

test("sections older than max_age_days, or with no written stamp, are dropped", async () => {
  await withStorageRoot(async (root) => {
    await emit(root, {
      project: "alpha",
      workflowName: "session-memory-sweep",
      body: "TWELVE_DAYS_OLD",
      at: new Date(NOW.getTime() - 12 * DAY_MS),
    });
    await emit(root, {
      project: "alpha",
      workflowName: "session-handoff-stop",
      body: "ONE_DAY_OLD",
      at: new Date(NOW.getTime() - DAY_MS),
    });
    const target = join(root, "pending-handoff.alpha.md");
    const existing = await Bun.file(target).text();
    writeFileSync(
      target,
      `${existing}<!-- penumbra:section hand-fenced -->\nUNSTAMPED\n<!-- /penumbra:section hand-fenced -->\n`,
    );

    const defaults = await read(root, "alpha");
    expect(defaults.result.body).toBe("ONE_DAY_OLD");

    const wide = await read(root, "alpha", { max_age_days: 30 });
    expect(wide.result.body).toBe("TWELVE_DAYS_OLD\n\nONE_DAY_OLD");

    const narrow = await read(root, "alpha", { max_age_days: 0.5 });
    expect(narrow.result.body).toBe("");
  });
});

test("caps the surfaced body at max_bytes", async () => {
  await withStorageRoot(async (root) => {
    await emit(root, {
      project: "alpha",
      workflowName: "session-handoff-stop",
      body: `HEAD\n${"x".repeat(5_000)}`,
    });

    const out = await read(root, "alpha", { max_bytes: 1_024 });

    expect(out.result.body.startsWith("HEAD\n")).toBe(true);
    expect(Buffer.byteLength(out.result.body)).toBeLessThanOrEqual(1_024);
    expect(out.result.truncated).toBe(true);
    expect(out.warnings).toHaveLength(1);
  });
});

test("a missing file or storage root yields an empty draft", async () => {
  await withStorageRoot(async (root) => {
    expect((await read(root, "alpha")).result.body).toBe("");
    expect((await read(undefined, "alpha")).result).toEqual({
      path: null,
      body: "",
      truncated: false,
    });
  });
});
