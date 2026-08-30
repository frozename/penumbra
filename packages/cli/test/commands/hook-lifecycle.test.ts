import {
  claudeCodeEventToLifecycle,
  defaultLifecycleForwardFn,
  runLifecycleForward,
} from "@src/commands/hook.js";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface LifecycleEvent {
  kind: "lifecycle";
  event: string;
  hookContext?: { tool_name?: string | null; file_path?: string | null };
}

test("runLifecycleForward calls forwardFn with kind=lifecycle and the given event", async () => {
  const calls: { event: string; toolName: string | null | undefined }[] = [];
  const fakeForward = (event: LifecycleEvent): Promise<void> => {
    calls.push({ event: event.event, toolName: event.hookContext?.tool_name });
    return Promise.resolve();
  };
  await runLifecycleForward({ event: "pre-compact", cwd: "/tmp", forwardFn: fakeForward });
  await runLifecycleForward({
    event: "stop",
    cwd: "/tmp",
    forwardFn: fakeForward,
    hookContext: { tool_name: "Edit" },
  });
  await runLifecycleForward({ event: "session-start", cwd: "/tmp", forwardFn: fakeForward });
  expect(calls).toEqual([
    { event: "pre-compact", toolName: undefined },
    { event: "stop", toolName: "Edit" },
    { event: "session-start", toolName: undefined },
  ]);
});

const realFetch = globalThis.fetch;

function withMockedFetch<T>(impl: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = realFetch;
  });
}

function withCapturedStdout<T>(fn: () => Promise<T>): Promise<{ result: T; chunks: string[] }> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const writableStdout = process.stdout as { write: typeof process.stdout.write };
  writableStdout.write = (data: string | Uint8Array): boolean => {
    chunks.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    return true;
  };
  return fn()
    .then((result) => ({ result, chunks }))
    .finally(() => {
      writableStdout.write = origWrite;
    });
}

function makeStorageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hook-life-"));
  writeFileSync(join(root, "port"), "12345");
  writeFileSync(join(root, "token"), "test-token");
  return root;
}

function fakeResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("defaultLifecycleForwardFn emits SessionStart envelope when daemon returns additionalContext", async () => {
  const root = makeStorageRoot();
  try {
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(fakeResponse({ matched: ["x"], additionalContext: "PROBE_CONTEXT" }));
    const { chunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = defaultLifecycleForwardFn(root, "/tmp");
        await fn({ kind: "lifecycle", event: "session-start" });
      }),
    );
    const written = chunks.join("");
    expect(written).toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "PROBE_CONTEXT",
        },
      }) + "\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultLifecycleForwardFn maps pre-compact / stop to PreCompact / Stop event names", async () => {
  const root = makeStorageRoot();
  try {
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(fakeResponse({ matched: [], additionalContext: "X" }));
    const { chunks: preChunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = defaultLifecycleForwardFn(root, "/tmp");
        await fn({ kind: "lifecycle", event: "pre-compact" });
      }),
    );
    expect(preChunks.join("")).toContain('"hookEventName":"PreCompact"');

    const { chunks: stopChunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = defaultLifecycleForwardFn(root, "/tmp");
        await fn({ kind: "lifecycle", event: "stop" });
      }),
    );
    expect(stopChunks.join("")).toContain('"hookEventName":"Stop"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claudeCodeEventToLifecycle maps Claude Code hook event names to lifecycle events", () => {
  expect(claudeCodeEventToLifecycle("SessionStart")).toBe("session-start");
  expect(claudeCodeEventToLifecycle("PreCompact")).toBe("pre-compact");
  expect(claudeCodeEventToLifecycle("Stop")).toBe("stop");
  expect(claudeCodeEventToLifecycle("UserPromptSubmit")).toBe("user-prompt-submit");
  expect(claudeCodeEventToLifecycle("PreToolUse")).toBe("pre-tool-use");
  expect(claudeCodeEventToLifecycle("PostToolUse")).toBe("post-tool-use");
  expect(claudeCodeEventToLifecycle(undefined)).toBeNull();
  expect(claudeCodeEventToLifecycle(null)).toBeNull();
});

test("defaultLifecycleForwardFn maps user-prompt-submit / post-tool-use to UserPromptSubmit / PostToolUse event names", async () => {
  const root = makeStorageRoot();
  try {
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(fakeResponse({ matched: [], additionalContext: "X" }));
    const { chunks: upsChunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = defaultLifecycleForwardFn(root, "/tmp");
        await fn({ kind: "lifecycle", event: "user-prompt-submit" });
      }),
    );
    expect(upsChunks.join("")).toContain('"hookEventName":"UserPromptSubmit"');

    const { chunks: ptuChunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = defaultLifecycleForwardFn(root, "/tmp");
        await fn({ kind: "lifecycle", event: "post-tool-use" });
      }),
    );
    expect(ptuChunks.join("")).toContain('"hookEventName":"PostToolUse"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface ForwardRequestBody {
  event: LifecycleEvent;
  cwd: string;
  hookContext: { tool_name: string | null; file_path: string | null };
  session_id: string | null;
  transcript_path: string | null;
}

test("defaultLifecycleForwardFn forwards hookContext.tool_name in the request body", async () => {
  const root = makeStorageRoot();
  try {
    let requestBody: ForwardRequestBody | null = null;
    const fakeFetch: typeof globalThis.fetch = (_input, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "null";
      requestBody = JSON.parse(bodyStr) as ForwardRequestBody;
      return Promise.resolve(fakeResponse({ matched: [], additionalContext: null }));
    };
    await withMockedFetch(fakeFetch, async () => {
      const fn = defaultLifecycleForwardFn(root, "/tmp");
      await fn({ kind: "lifecycle", event: "post-tool-use", hookContext: { tool_name: "Edit" } });
    });

    expect(requestBody).toEqual({
      event: {
        kind: "lifecycle",
        event: "post-tool-use",
        hookContext: { tool_name: "Edit" },
      },
      cwd: "/tmp",
      hookContext: { tool_name: "Edit", file_path: null },
      session_id: null,
      transcript_path: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultLifecycleForwardFn forwards hookContext.file_path for pre-tool-use events", async () => {
  const root = makeStorageRoot();
  try {
    let requestBody: ForwardRequestBody | null = null;
    const fakeFetch: typeof globalThis.fetch = (_input, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "null";
      requestBody = JSON.parse(bodyStr) as ForwardRequestBody;
      return Promise.resolve(fakeResponse({ matched: [], additionalContext: null }));
    };
    await withMockedFetch(fakeFetch, async () => {
      const fn = defaultLifecycleForwardFn(root, "/tmp");
      await fn({
        kind: "lifecycle",
        event: "pre-tool-use",
        hookContext: { tool_name: "Read", file_path: "/tmp/foo.ts" },
      });
    });

    expect(requestBody!.event.event).toBe("pre-tool-use");
    expect(requestBody!.hookContext).toEqual({ tool_name: "Read", file_path: "/tmp/foo.ts" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultLifecycleForwardFn maps pre-tool-use to PreToolUse hookEventName", async () => {
  const root = makeStorageRoot();
  try {
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(fakeResponse({ matched: [], additionalContext: "X" }));
    const { chunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = defaultLifecycleForwardFn(root, "/tmp");
        await fn({ kind: "lifecycle", event: "pre-tool-use" });
      }),
    );
    expect(chunks.join("")).toContain('"hookEventName":"PreToolUse"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultLifecycleForwardFn writes nothing when additionalContext is null/empty", async () => {
  const root = makeStorageRoot();
  try {
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(fakeResponse({ matched: [], additionalContext: null }));
    const { chunks } = await withMockedFetch(fakeFetch, () =>
      withCapturedStdout(async () => {
        const fn = defaultLifecycleForwardFn(root, "/tmp");
        await fn({ kind: "lifecycle", event: "session-start" });
      }),
    );
    expect(chunks.join("")).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
