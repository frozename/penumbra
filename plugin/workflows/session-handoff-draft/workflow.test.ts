import type { RecallBundle, WorkflowCtx } from "@penumbra/workflows";

import { loadSqliteVec, migrate, SessionNoteDrafts } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { fn } from "./workflow.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

type ChainStartInput = {
  initial_agent?: string;
  task_class?: string;
  task_type?: string;
  tool_free?: boolean;
  use_worktree?: boolean;
  max_hops?: number;
};

type DraftRunResult = {
  skipped?: boolean;
  reason?: string;
  warnings?: string[];
  draft_id?: string;
  handoff_id?: string;
  draft_path?: string;
  skeleton_path?: string;
  period_key?: string;
  sections?: number;
};

const GOOD_RESPONSE = [
  "## Narrative and traps learned",
  "",
  "The skeleton says the branch is mid-flight and the test gate is pending.",
  "",
  "## Open follow-ups (worst-first)",
  "",
  "- Re-run the final gate after the draft is approved.",
].join("\n");

function periodKeyForNow(): string {
  const now = new Date();
  const tz = process.env.TZ ?? "UTC";
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const hour = Number.parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(now),
    10,
  );
  return `${date}-${hour < 12 ? "am" : "pm"}`;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function recall(): RecallBundle {
  return { byKey: {}, warnings: [], estimatedTokens: 0 };
}

function makeCtx(opts: {
  root: string;
  db: Database;
  dispatch?: WorkflowCtx["dispatch"];
  awaitChain?: WorkflowCtx["awaitChain"];
  chainStart?: (input: ChainStartInput) => Promise<Response> | Response;
  args?: Record<string, unknown>;
}): WorkflowCtx {
  return {
    config: {},
    cwd: opts.root,
    storageRoot: opts.root,
    project: "penumbra",
    args: opts.args ?? {},
    db: () => opts.db,
    dispatch:
      opts.dispatch ??
      (async () => ({ conversation_id: "conversation-1", handoff_id: "handoff-1" })),
    awaitChain:
      opts.awaitChain ??
      (async () => ({
        status: "completed",
        final_agent: "executor",
        response_text: GOOD_RESPONSE,
      })),
    cancel: async () => {},
    fileWrite: async (relativePath, body) => {
      const path = isAbsolute(relativePath) ? relativePath : join(opts.root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      return path;
    },
    chainStart:
      opts.chainStart ??
      (async () => Response.json({ conversation_id: "conversation-1", handoff_id: "handoff-1" })),
  } as WorkflowCtx;
}

function writeSkeleton(root: string, body = "<!-- penumbra:session s-1 -->\nFacts\n"): string {
  const path = join(root, "docs/notes", `maestro-continuation-${periodKeyForNow()}.skeleton.md`);
  mkdirSync(join(root, "docs/notes"), { recursive: true });
  writeFileSync(path, body);
  return path;
}

test("dispatches with initial_agent as a ROLE and never a seat", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-role-"));
  const db = freshDb();
  const dispatches: ChainStartInput[] = [];
  try {
    writeSkeleton(root);
    const result = (await fn(
      makeCtx({
        root,
        db,
        args: { initial_agent: "codex-acp-deep", agent: "claude-acp-sonnet" },
        chainStart: async (input) => {
          dispatches.push(input);
          return Response.json({
            conversation_id: "conversation-role",
            handoff_id: "handoff-role",
          });
        },
      }),
      recall(),
    )) as DraftRunResult;

    expect(result.handoff_id).toBe("handoff-role");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.initial_agent).toBe("executor");
    expect(dispatches[0]?.initial_agent).not.toBe("codex-acp-deep");
    expect(dispatches[0]?.task_class).toBe("TRIVIAL");
    expect(dispatches[0]?.task_type).toBe("docs_mechanical");
    expect(dispatches[0]?.use_worktree).toBe(false);
    expect(dispatches[0]?.tool_free).toBe(true);
    expect(dispatches[0]?.max_hops).toBe(1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("when fleet capacity is unavailable, returns the facts-only skeleton unchanged with a warning", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-capacity-"));
  const db = freshDb();
  try {
    const skeletonPath = writeSkeleton(root, "<!-- penumbra:session s-1 -->\nOriginal skeleton\n");
    const original = readFileSync(skeletonPath, "utf8");
    const result = (await fn(
      makeCtx({
        root,
        db,
        chainStart: async () => {
          throw new Error("HTTP 429 provider capacity unavailable");
        },
      }),
      recall(),
    )) as DraftRunResult;

    expect(result.skipped).toBe(true);
    expect(result.warnings?.[0]).toContain("draft skipped:");
    expect(readFileSync(skeletonPath, "utf8")).toBe(original);
    expect(existsSync(skeletonPath.replace(/\.skeleton\.md$/, ".draft.md"))).toBe(false);
    expect(new SessionNoteDrafts(db).list()).toHaveLength(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("when chainStart is unavailable, skips without using dispatch or writing a draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-no-chain-"));
  const db = freshDb();
  try {
    const skeletonPath = writeSkeleton(root, "<!-- penumbra:session s-1 -->\nOriginal skeleton\n");
    const original = readFileSync(skeletonPath, "utf8");
    let dispatchCalled = false;
    const ctx = makeCtx({
      root,
      db,
      dispatch: async () => {
        dispatchCalled = true;
        return { conversation_id: "conversation-fallback", handoff_id: "handoff-fallback" };
      },
    }) as WorkflowCtx & { chainStart?: unknown };
    delete ctx.chainStart;

    const result = (await fn(ctx, recall())) as DraftRunResult;

    expect(result).toMatchObject({
      skipped: true,
      reason: "dispatch unavailable",
    });
    expect(result.warnings).toEqual(["draft skipped: dispatch unavailable"]);
    expect(dispatchCalled).toBe(false);
    expect(readFileSync(skeletonPath, "utf8")).toBe(original);
    expect(existsSync(skeletonPath.replace(/\.skeleton\.md$/, ".draft.md"))).toBe(false);
    expect(new SessionNoteDrafts(db).list()).toHaveLength(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed fleet output fails closed without a draft file or row", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-malformed-"));
  const db = freshDb();
  try {
    const skeletonPath = writeSkeleton(root);
    const result = (await fn(
      makeCtx({
        root,
        db,
        awaitChain: async () => ({
          status: "completed",
          final_agent: "executor",
          response_text: "## Narrative and traps learned\nMissing the second heading.",
        }),
      }),
      recall(),
    )) as DraftRunResult;

    expect(result.skipped).toBe(true);
    expect(result.warnings?.[0]).toContain("draft skipped:");
    expect(existsSync(skeletonPath.replace(/\.skeleton\.md$/, ".draft.md"))).toBe(false);
    expect(new SessionNoteDrafts(db).list()).toHaveLength(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fleet response with a glued preamble before the narrative heading is accepted", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-glued-preamble-"));
  const db = freshDb();
  try {
    const skeletonPath = writeSkeleton(root);
    const result = (await fn(
      makeCtx({
        root,
        db,
        awaitChain: async () => ({
          status: "completed",
          final_agent: "executor",
          response_text: `I'm applying the required format.## Narrative and traps learned

The skeleton says the branch is mid-flight.

## Open follow-ups (worst-first)

- Re-run the final gate.`,
        }),
      }),
      recall(),
    )) as DraftRunResult;

    expect(result.sections).toBe(2);
    const draftBody = readFileSync(result.draft_path!, "utf8");
    expect(draftBody).toContain("Facts\n\n## Narrative and traps learned");
    expect(draftBody).not.toContain("I'm applying the required format.");
    expect(new SessionNoteDrafts(db).list()).toHaveLength(1);
    expect(existsSync(skeletonPath.replace(/\.skeleton\.md$/, ".draft.md"))).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fleet response with a standalone preamble before the narrative heading is accepted", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-standalone-preamble-"));
  const db = freshDb();
  try {
    writeSkeleton(root);
    const result = (await fn(
      makeCtx({
        root,
        db,
        awaitChain: async () => ({
          status: "completed",
          final_agent: "executor",
          response_text: `A short preamble.

## Narrative and traps learned

The skeleton says the branch is mid-flight.

## Open follow-ups (worst-first)

- Re-run the final gate.`,
        }),
      }),
      recall(),
    )) as DraftRunResult;

    expect(result.sections).toBe(2);
    const draftBody = readFileSync(result.draft_path!, "utf8");
    expect(draftBody).toContain("Facts\n\n## Narrative and traps learned");
    expect(draftBody).not.toContain("A short preamble.");
    expect(new SessionNoteDrafts(db).list()).toHaveLength(1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a narrative heading mention without a follow-ups heading at line start is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-heading-mention-"));
  const db = freshDb();
  try {
    const skeletonPath = writeSkeleton(root);
    const result = (await fn(
      makeCtx({
        root,
        db,
        awaitChain: async () => ({
          status: "completed",
          final_agent: "executor",
          response_text:
            "The phrase ## Narrative and traps learned appears here, but there is no valid follow-up heading.",
        }),
      }),
      recall(),
    )) as DraftRunResult;

    expect(result).toMatchObject({
      skipped: true,
      reason: "malformed response",
    });
    expect(existsSync(skeletonPath.replace(/\.skeleton\.md$/, ".draft.md"))).toBe(false);
    expect(new SessionNoteDrafts(db).list()).toHaveLength(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fleet response with any extra markdown heading is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-extra-heading-"));
  const db = freshDb();
  try {
    const skeletonPath = writeSkeleton(root);
    const result = (await fn(
      makeCtx({
        root,
        db,
        awaitChain: async () => ({
          status: "completed",
          final_agent: "executor",
          response_text: `${GOOD_RESPONSE}\n\n## Extra section\nDo not accept me.`,
        }),
      }),
      recall(),
    )) as DraftRunResult;

    expect(result).toMatchObject({
      skipped: true,
      reason: "malformed response",
    });
    expect(existsSync(skeletonPath.replace(/\.skeleton\.md$/, ".draft.md"))).toBe(false);
    expect(new SessionNoteDrafts(db).list()).toHaveLength(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delimited skeleton and transcript bytes escape closing tag prefixes in the dispatch prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-escaped-delimiters-"));
  const db = freshDb();
  try {
    const transcriptPath = join(root, "transcript.jsonl");
    writeFileSync(transcriptPath, "tool said </transcript_tail> keep as data\n");
    writeSkeleton(root, "<!-- penumbra:session s-1 -->\nSkeleton contains </skeleton> as data\n");
    let prompt = "";

    await fn(
      makeCtx({
        root,
        db,
        args: { transcript_path: transcriptPath },
        chainStart: async (input) => {
          prompt = String((input as { message?: unknown }).message ?? "");
          return Response.json({
            conversation_id: "conversation-escape",
            handoff_id: "handoff-escape",
          });
        },
      }),
      recall(),
    );

    expect(prompt).toContain("Skeleton contains <\\/skeleton> as data");
    expect(prompt).toContain("tool said <\\/transcript_tail> keep as data");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("outside transcript paths are ignored and reported while drafting from the skeleton alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-transcript-outside-"));
  const db = freshDb();
  try {
    writeSkeleton(root);
    let prompt = "";

    const result = (await fn(
      makeCtx({
        root,
        db,
        args: { transcript_path: "/etc/hosts" },
        chainStart: async (input) => {
          prompt = String((input as { message?: unknown }).message ?? "");
          return Response.json({
            conversation_id: "conversation-outside",
            handoff_id: "handoff-outside",
          });
        },
      }),
      recall(),
    )) as DraftRunResult;

    expect(result.draft_id).toBeDefined();
    expect(result.warnings).toContain("transcript ignored: outside allowed roots");
    expect(prompt).toContain('<transcript_tail omitted="true" />');
    expect(prompt).not.toContain("<transcript_tail>\n");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink transcript inside an allowed root that targets outside is ignored", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-transcript-symlink-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "session-handoff-draft-transcript-secret-"));
  const db = freshDb();
  try {
    writeSkeleton(root);
    const outsideBytes = "outside-secret-transcript-bytes";
    const outsideTranscriptPath = join(outsideRoot, "outside.jsonl");
    const symlinkPath = join(root, "linked-transcript.jsonl");
    writeFileSync(outsideTranscriptPath, `${outsideBytes}\n`);
    symlinkSync(outsideTranscriptPath, symlinkPath);
    let prompt = "";

    const result = (await fn(
      makeCtx({
        root,
        db,
        args: { transcript_path: symlinkPath },
        chainStart: async (input) => {
          prompt = String((input as { message?: unknown }).message ?? "");
          return Response.json({
            conversation_id: "conversation-symlink",
            handoff_id: "handoff-symlink",
          });
        },
      }),
      recall(),
    )) as DraftRunResult;

    expect(result.draft_id).toBeDefined();
    expect(result.warnings).toContain("transcript ignored: outside allowed roots");
    expect(prompt).toContain('<transcript_tail omitted="true" />');
    expect(prompt).not.toContain(outsideBytes);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("a transcript file inside an allowed root is still read", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-transcript-inside-"));
  const db = freshDb();
  try {
    writeSkeleton(root);
    const transcriptBytes = "inside-transcript-bytes";
    const transcriptPath = join(root, "transcript.jsonl");
    writeFileSync(transcriptPath, `${transcriptBytes}\n`);
    let prompt = "";

    const result = (await fn(
      makeCtx({
        root,
        db,
        args: { transcript_path: transcriptPath },
        chainStart: async (input) => {
          prompt = String((input as { message?: unknown }).message ?? "");
          return Response.json({
            conversation_id: "conversation-inside",
            handoff_id: "handoff-inside",
          });
        },
      }),
      recall(),
    )) as DraftRunResult;

    expect(result.draft_id).toBeDefined();
    expect(result.warnings).not.toContain("transcript ignored: outside allowed roots");
    expect(prompt).toContain(`<transcript_tail>\n${transcriptBytes}\n`);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("skeleton prompt data is capped at 32 KiB from the head", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-skeleton-cap-"));
  const db = freshDb();
  try {
    writeSkeleton(root, `head-marker\n${"x".repeat(40 * 1024)}\ntail-sentinel\n`);
    let prompt = "";

    await fn(
      makeCtx({
        root,
        db,
        chainStart: async (input) => {
          prompt = String((input as { message?: unknown }).message ?? "");
          return Response.json({
            conversation_id: "conversation-cap",
            handoff_id: "handoff-cap",
          });
        },
      }),
      recall(),
    );

    expect(prompt).toContain("head-marker");
    expect(prompt).not.toContain("tail-sentinel");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful dispatch writes the draft with the stamp first and registers an awaiting_approval row", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-success-"));
  const db = freshDb();
  try {
    const skeletonPath = writeSkeleton(root, "<!-- penumbra:session s-1 -->\nFacts body\n");
    const result = (await fn(
      makeCtx({
        root,
        db,
        args: { session_id: "s-1" },
        chainStart: async () =>
          Response.json({
            conversation_id: "conversation-success",
            handoff_id: "handoff-success",
          }),
      }),
      recall(),
    )) as DraftRunResult;

    expect(result.draft_id).toBeDefined();
    expect(result.handoff_id).toBe("handoff-success");
    expect(result.skeleton_path).toBe(skeletonPath);
    expect(result.draft_path).toBe(skeletonPath.replace(/\.skeleton\.md$/, ".draft.md"));
    const draftBody = readFileSync(result.draft_path!, "utf8");
    expect(draftBody.split("\n")[0]).toBe("<!-- penumbra:session s-1 -->");
    expect(draftBody).toContain("Facts body");
    expect(draftBody).toContain("## Narrative and traps learned");
    expect(draftBody).toContain("## Open follow-ups (worst-first)");

    const rows = new SessionNoteDrafts(db).list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      draft_id: result.draft_id,
      session_id: "s-1",
      project_id: "penumbra",
      period_key: result.period_key,
      skeleton_path: skeletonPath,
      draft_path: result.draft_path,
      note_path: skeletonPath.replace(/\.skeleton\.md$/, ".md"),
      handoff_id: "handoff-success",
      status: "awaiting_approval",
      composed_event_id: null,
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("registerDraft failure leaves no draft file, temp file, or row", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-register-fail-"));
  const db = freshDb();
  const originalRegisterDraft = SessionNoteDrafts.prototype.registerDraft;
  SessionNoteDrafts.prototype.registerDraft = (): never => {
    throw new Error("simulated registration failure");
  };
  try {
    const skeletonPath = writeSkeleton(root);

    const result = (await fn(makeCtx({ root, db }), recall())) as DraftRunResult;

    expect(result).toMatchObject({
      skipped: true,
      reason: "registration failed",
    });
    expect(existsSync(skeletonPath.replace(/\.skeleton\.md$/, ".draft.md"))).toBe(false);
    expect(readdirSync(dirname(skeletonPath)).filter((entry) => entry.includes(".tmp-"))).toEqual(
      [],
    );
    expect(new SessionNoteDrafts(db).list()).toHaveLength(0);
  } finally {
    SessionNoteDrafts.prototype.registerDraft = originalRegisterDraft;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing db helper skips before writing any draft file", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-no-db-"));
  const db = freshDb();
  try {
    const skeletonPath = writeSkeleton(root);
    const ctx = makeCtx({ root, db }) as WorkflowCtx & { db?: unknown };
    delete ctx.db;

    const result = (await fn(ctx, recall())) as DraftRunResult;

    expect(result).toMatchObject({
      skipped: true,
      reason: "db unavailable",
    });
    expect(existsSync(skeletonPath.replace(/\.skeleton\.md$/, ".draft.md"))).toBe(false);
    expect(new SessionNoteDrafts(db).list()).toHaveLength(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two drafts for the same period leave only the newest awaiting approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-supersede-"));
  const db = freshDb();
  try {
    writeSkeleton(root);

    const first = (await fn(
      makeCtx({
        root,
        db,
        chainStart: async () =>
          Response.json({ conversation_id: "conversation-one", handoff_id: "handoff-one" }),
      }),
      recall(),
    )) as DraftRunResult;
    const second = (await fn(
      makeCtx({
        root,
        db,
        chainStart: async () =>
          Response.json({ conversation_id: "conversation-two", handoff_id: "handoff-two" }),
      }),
      recall(),
    )) as DraftRunResult;

    const rows = new SessionNoteDrafts(db).list();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.draft_id === first.draft_id)?.status).toBe("rejected");
    expect(rows.find((row) => row.draft_id === second.draft_id)?.status).toBe("awaiting_approval");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo_root arg lets a subdirectory cwd find the root skeleton", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-repo-root-"));
  const db = freshDb();
  try {
    const skeletonPath = writeSkeleton(root);
    const subdir = join(root, "packages/core");
    mkdirSync(subdir, { recursive: true });

    const result = (await fn(
      makeCtx({
        root: subdir,
        db,
        args: { repo_root: root },
      }),
      recall(),
    )) as DraftRunResult;

    expect(result.skeleton_path).toBe(skeletonPath);
    expect(existsSync(skeletonPath.replace(/\.skeleton\.md$/, ".draft.md"))).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("awaitChain uses the 120 second default timeout unless args override it", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-timeout-"));
  const db = freshDb();
  const timeoutValues: unknown[] = [];
  try {
    writeSkeleton(root);

    await fn(
      makeCtx({
        root,
        db,
        awaitChain: async (_conversationId, opts) => {
          timeoutValues.push(opts?.timeoutMs);
          return { status: "completed", final_agent: "executor", response_text: GOOD_RESPONSE };
        },
      }),
      recall(),
    );
    await fn(
      makeCtx({
        root,
        db,
        args: { timeout_ms: 5000 },
        awaitChain: async (_conversationId, opts) => {
          timeoutValues.push(opts?.timeoutMs);
          return { status: "completed", final_agent: "executor", response_text: GOOD_RESPONSE };
        },
      }),
      recall(),
    );

    expect(timeoutValues).toEqual([120_000, 5000]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("no skeleton for the period skips with a warning", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-handoff-draft-noskeleton-"));
  const db = freshDb();
  try {
    const result = (await fn(makeCtx({ root, db }), recall())) as DraftRunResult;

    expect(result).toMatchObject({
      skipped: true,
      reason: "no skeleton for period",
    });
    expect(result.warnings?.[0]).toContain("draft skipped: no skeleton for period");
    expect(new SessionNoteDrafts(db).list()).toHaveLength(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
