import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyOrigin,
  isLongLivedAgentEnv,
  isSdkEntrypointEnv,
  mapClaudeCodeEvent,
  runHook,
  shouldSkipLifecycleForwarding,
} from "../src/commands/hook.js";

test("mapClaudeCodeEvent produces an agent-prompt T0 event for UserPromptSubmit", () => {
  const ev = mapClaudeCodeEvent(
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "help me refactor this file",
      session_id: "cc-session-1",
      cwd: "/Volumes/WorkSSD/repos/personal/myproj",
    },
    { project: null, sessionId: null },
  );
  expect(ev).not.toBeNull();
  expect(ev!.source).toBe("claude-code");
  expect(ev!.event_type).toBe("agent-prompt");
  expect(ev!.lane).toBe("cli-subscription");
  expect(ev!.session_id).toBe("cc-session-1");
  expect(ev!.payload_summary).toBe("help me refactor this file");
});

test("mapClaudeCodeEvent produces an agent-tool-use T0 event for PreToolUse", () => {
  const ev = mapClaudeCodeEvent(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls", description: "list dir" },
      session_id: "cc-session-1",
    },
    { project: "myproj", sessionId: null },
  );
  expect(ev).not.toBeNull();
  expect(ev!.event_type).toBe("agent-tool-use");
  expect(ev!.project_id).toBe("myproj");
  expect(ev!.payload_summary).toMatch(/^Bash/);
});

test("mapClaudeCodeEvent drops Pre/PostToolUse for mcp__penumbra__memory_recall to avoid recall self-pollution", () => {
  const pre = mapClaudeCodeEvent(
    {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__penumbra__memory_recall",
      tool_input: { query: "anything" },
    },
    { project: null, sessionId: null },
  );
  expect(pre).toBeNull();

  const post = mapClaudeCodeEvent(
    {
      hook_event_name: "PostToolUse",
      tool_name: "mcp__penumbra__memory_recall",
      tool_input: { query: "anything" },
      tool_response: { results: [{ body: "something" }] },
    },
    { project: null, sessionId: null },
  );
  expect(post).toBeNull();

  // Other tools are still captured
  const otherPre = mapClaudeCodeEvent(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
    { project: null, sessionId: null },
  );
  expect(otherPre).not.toBeNull();
});

test("mapClaudeCodeEvent skips unknown hook events", () => {
  const ev = mapClaudeCodeEvent(
    { hook_event_name: "UnknownEvent" },
    { project: null, sessionId: null },
  );
  expect(ev).toBeNull();
});

interface ObservationBody {
  event_type?: string;
  source?: string;
}

test("runHook posts to /observations on the live daemon", async () => {
  let received: { headers: Headers; body: ObservationBody } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { headers: req.headers, body: (await req.json()) as ObservationBody };
      return Response.json({ event_id: "cc-1" });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "penumbra-hook-test-"));
  writeFileSync(join(root, "port"), `${String(server.port)}\n`);
  writeFileSync(join(root, "token"), "tk\n");

  const exit = await runHook({
    storageRoot: root,
    rawEvent: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "hi",
      session_id: "s-1",
    }),
    project: null,
    sessionId: null,
  });
  try {
    expect(exit).toBe(0);
    expect(received).not.toBeNull();
    expect(received!.headers.get("authorization")).toBe("Bearer tk");
    expect(received!.body.event_type).toBe("agent-prompt");
    expect(received!.body.source).toBe("claude-code");
  } finally {
    void server.stop(true);
  }
});

test("mapClaudeCodeEvent derives project_id from cwd when no --project flag is given", () => {
  // Build a self-contained git repo with an origin so resolveProjectId hits the git branch.
  const repo = mkdtempSync(join(tmpdir(), "penumbra-hook-proj-"));
  spawnSync("git", ["-C", repo, "init", "-q"]);
  spawnSync("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "https://example.test/penumbra-hook-fixture.git",
  ]);
  const ev = mapClaudeCodeEvent(
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
      cwd: repo,
    },
    { project: null, sessionId: null },
  );
  expect(ev).not.toBeNull();
  // Format from resolveProjectId git-kind: "<16-hex>:<posix-relpath>" (relpath '.' for repo root).
  expect(ev!.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});

test("mapClaudeCodeEvent prefers explicit --project over cwd-derived id", () => {
  const repo = mkdtempSync(join(tmpdir(), "penumbra-hook-proj-"));
  spawnSync("git", ["-C", repo, "init", "-q"]);
  spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://example.test/repo.git"]);
  const ev = mapClaudeCodeEvent(
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
      cwd: repo,
    },
    { project: "declared-id", sessionId: null },
  );
  expect(ev!.project_id).toBe("declared-id");
});

test("mapClaudeCodeEvent leaves project_id null when cwd is not a repo and no flag given", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-hook-noproj-"));
  const ev = mapClaudeCodeEvent(
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
      cwd: dir,
    },
    { project: null, sessionId: null },
  );
  expect(ev!.project_id).toBeNull();
});

interface TriggerCall {
  event?: { event?: string };
  hookContext?: { tool_name?: string | null; file_path?: string | null };
  session_id?: string | null;
  transcript_path?: string | null;
}

function stubStdoutWrite(chunks: string[]): () => void {
  const oldWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    const text = String(chunk);
    if (text.includes('"hookSpecificOutput"')) {
      chunks.push(text);
    }
    return true;
  };
  return (): void => {
    process.stdout.write = oldWrite;
  };
}

test("isLongLivedAgentEnv detects non-empty long-lived runtime markers", () => {
  expect(isLongLivedAgentEnv({})).toBe(false);
  expect(
    isLongLivedAgentEnv({
      PENUMBRA_LONG_LIVED_TICK_ID: "",
      PENUMBRA_LONG_LIVED_AGENT_ID: "   ",
    }),
  ).toBe(false);
  expect(isLongLivedAgentEnv({ PENUMBRA_LONG_LIVED_TICK_ID: "tick-1" })).toBe(true);
  expect(isLongLivedAgentEnv({ PENUMBRA_LONG_LIVED_AGENT_ID: "agent-1" })).toBe(true);
});

test("isSdkEntrypointEnv detects SDK-driven Claude Code sessions", () => {
  expect(isSdkEntrypointEnv({})).toBe(false);
  expect(isSdkEntrypointEnv({ CLAUDE_CODE_ENTRYPOINT: "" })).toBe(false);
  expect(isSdkEntrypointEnv({ CLAUDE_CODE_ENTRYPOINT: "   " })).toBe(false);
  expect(isSdkEntrypointEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(false);
  expect(isSdkEntrypointEnv({ CLAUDE_CODE_ENTRYPOINT: "claude-vscode" })).toBe(false);
  expect(isSdkEntrypointEnv({ CLAUDE_CODE_ENTRYPOINT: "sdk-ts" })).toBe(true);
  expect(isSdkEntrypointEnv({ CLAUDE_CODE_ENTRYPOINT: "sdk-py" })).toBe(true);
  expect(isSdkEntrypointEnv({ CLAUDE_CODE_ENTRYPOINT: " SDK-TS " })).toBe(true);
});

test("shouldSkipLifecycleForwarding checks SDK entrypoint and long-lived markers", () => {
  expect(shouldSkipLifecycleForwarding({ CLAUDE_CODE_ENTRYPOINT: "sdk-ts" })).toBe(true);
  expect(shouldSkipLifecycleForwarding({ PENUMBRA_LONG_LIVED_TICK_ID: "tick-1" })).toBe(true);
  expect(shouldSkipLifecycleForwarding({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(false);
  expect(shouldSkipLifecycleForwarding({})).toBe(false);
});

test("runHook forwards PreToolUse:Read events as pre-tool-use lifecycle with file_path", async () => {
  const oldEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const triggerCalls: TriggerCall[] = [];
  const observationCalls: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/workflows/trigger") {
        triggerCalls.push((await req.json()) as TriggerCall);
        return Response.json({ matched: [], additionalContext: null });
      }
      if (url.pathname === "/sessions/touch") {
        return Response.json({});
      }
      if (url.pathname === "/observations") {
        observationCalls.push(await req.json());
        return Response.json({ event_id: "pt-1" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "penumbra-hook-pre-"));
  writeFileSync(join(root, "port"), `${String(server.port)}\n`);
  writeFileSync(join(root, "token"), "tk\n");

  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";

  try {
    const exit = await runHook({
      storageRoot: root,
      rawEvent: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/repo/src/foo.ts" },
        session_id: "cc-pre-1",
      }),
      project: null,
      sessionId: null,
    });
    expect(exit).toBe(0);
    const trigger = triggerCalls.find((c) => c.event?.event === "pre-tool-use");
    expect(trigger).toBeTruthy();
    expect(trigger!.hookContext).toEqual({ tool_name: "Read", file_path: "/repo/src/foo.ts" });
    expect(trigger!.session_id).toBe("cc-pre-1");
  } finally {
    if (oldEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntrypoint;
    void server.stop(true);
  }
});

test("runHook skips SessionStart lifecycle forwarding for long-lived agent ticks", async () => {
  const oldTickId = process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  const oldAgentId = process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  const oldEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const triggerCalls: TriggerCall[] = [];
  const touchCalls: unknown[] = [];
  const stdoutChunks: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/workflows/trigger") {
        triggerCalls.push((await req.json()) as TriggerCall);
        return Response.json({ matched: [], additionalContext: "PRIME" });
      }
      if (url.pathname === "/sessions/touch") {
        touchCalls.push(await req.json());
        return Response.json({});
      }
      return new Response("not found", { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "penumbra-hook-ll-start-"));
  writeFileSync(join(root, "port"), `${String(server.port)}\n`);
  writeFileSync(join(root, "token"), "tk\n");

  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
  const restoreStdoutWrite = stubStdoutWrite(stdoutChunks);

  try {
    const exit = await runHook({
      storageRoot: root,
      rawEvent: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "cc-long-lived-start-1",
      }),
      project: null,
      sessionId: null,
    });
    expect(exit).toBe(0);
    expect(touchCalls).toHaveLength(1);
    expect(triggerCalls).toHaveLength(0);
    expect(stdoutChunks).toHaveLength(0);
  } finally {
    if (oldTickId === undefined) delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
    else process.env.PENUMBRA_LONG_LIVED_TICK_ID = oldTickId;
    if (oldAgentId === undefined) delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
    else process.env.PENUMBRA_LONG_LIVED_AGENT_ID = oldAgentId;
    if (oldEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntrypoint;
    restoreStdoutWrite();
    void server.stop(true);
  }
});

test("runHook skips SessionStart lifecycle forwarding for SDK-driven sessions", async () => {
  const oldTickId = process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  const oldAgentId = process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  const oldEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const triggerCalls: TriggerCall[] = [];
  const touchCalls: unknown[] = [];
  const stdoutChunks: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/workflows/trigger") {
        triggerCalls.push((await req.json()) as TriggerCall);
        return Response.json({ matched: [], additionalContext: "PRIME" });
      }
      if (url.pathname === "/sessions/touch") {
        touchCalls.push(await req.json());
        return Response.json({});
      }
      return new Response("not found", { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "penumbra-hook-sdk-start-"));
  writeFileSync(join(root, "port"), `${String(server.port)}\n`);
  writeFileSync(join(root, "token"), "tk\n");

  delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  const restoreStdoutWrite = stubStdoutWrite(stdoutChunks);

  try {
    const exit = await runHook({
      storageRoot: root,
      rawEvent: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "cc-sdk-start-1",
      }),
      project: null,
      sessionId: null,
    });
    expect(exit).toBe(0);
    expect(touchCalls).toHaveLength(1);
    expect(triggerCalls).toHaveLength(0);
    expect(stdoutChunks).toHaveLength(0);
  } finally {
    if (oldTickId === undefined) delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
    else process.env.PENUMBRA_LONG_LIVED_TICK_ID = oldTickId;
    if (oldAgentId === undefined) delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
    else process.env.PENUMBRA_LONG_LIVED_AGENT_ID = oldAgentId;
    if (oldEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntrypoint;
    restoreStdoutWrite();
    void server.stop(true);
  }
});

test("runHook captures lifecycle skip env before asynchronous session touch", async () => {
  const oldTickId = process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  const oldAgentId = process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  const oldEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const triggerCalls: TriggerCall[] = [];
  const touchCalls: unknown[] = [];
  const stdoutChunks: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/sessions/touch") {
        touchCalls.push(await req.json());
        process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
        return Response.json({});
      }
      if (url.pathname === "/workflows/trigger") {
        triggerCalls.push((await req.json()) as TriggerCall);
        return Response.json({ matched: [], additionalContext: "PRIME" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "penumbra-hook-sdk-snapshot-"));
  writeFileSync(join(root, "port"), `${String(server.port)}\n`);
  writeFileSync(join(root, "token"), "tk\n");

  delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  const restoreStdoutWrite = stubStdoutWrite(stdoutChunks);

  try {
    const exit = await runHook({
      storageRoot: root,
      rawEvent: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "cc-sdk-snapshot-1",
      }),
      project: null,
      sessionId: null,
    });
    expect(exit).toBe(0);
    expect(touchCalls).toHaveLength(1);
    expect(triggerCalls).toHaveLength(0);
    expect(stdoutChunks).toHaveLength(0);
  } finally {
    if (oldTickId === undefined) delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
    else process.env.PENUMBRA_LONG_LIVED_TICK_ID = oldTickId;
    if (oldAgentId === undefined) delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
    else process.env.PENUMBRA_LONG_LIVED_AGENT_ID = oldAgentId;
    if (oldEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntrypoint;
    restoreStdoutWrite();
    void server.stop(true);
  }
});

test("runHook captures long-lived lifecycle skip env before asynchronous session touch", async () => {
  const oldTickId = process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  const oldAgentId = process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  const oldEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const triggerCalls: TriggerCall[] = [];
  const touchCalls: unknown[] = [];
  const stdoutChunks: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/sessions/touch") {
        touchCalls.push(await req.json());
        process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
        return Response.json({});
      }
      if (url.pathname === "/workflows/trigger") {
        triggerCalls.push((await req.json()) as TriggerCall);
        return Response.json({ matched: [], additionalContext: "PRIME" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "penumbra-hook-ll-snapshot-"));
  writeFileSync(join(root, "port"), `${String(server.port)}\n`);
  writeFileSync(join(root, "token"), "tk\n");

  delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
  const restoreStdoutWrite = stubStdoutWrite(stdoutChunks);

  try {
    const exit = await runHook({
      storageRoot: root,
      rawEvent: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "cc-ll-snapshot-1",
      }),
      project: null,
      sessionId: null,
    });
    expect(exit).toBe(0);
    expect(touchCalls).toHaveLength(1);
    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0]!.session_id).toBe("cc-ll-snapshot-1");
    expect(stdoutChunks.join("")).toContain('"additionalContext":"PRIME"');
  } finally {
    if (oldTickId === undefined) delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
    else process.env.PENUMBRA_LONG_LIVED_TICK_ID = oldTickId;
    if (oldAgentId === undefined) delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
    else process.env.PENUMBRA_LONG_LIVED_AGENT_ID = oldAgentId;
    if (oldEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntrypoint;
    restoreStdoutWrite();
    void server.stop(true);
  }
});

test("runHook preserves PostToolUse observations for long-lived agent ticks", async () => {
  const oldTickId = process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  const oldAgentId = process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  const oldEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const triggerCalls: TriggerCall[] = [];
  const observationCalls: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/workflows/trigger") {
        triggerCalls.push((await req.json()) as TriggerCall);
        return Response.json({ matched: [], additionalContext: null });
      }
      if (url.pathname === "/sessions/touch") {
        return Response.json({});
      }
      if (url.pathname === "/observations") {
        observationCalls.push(await req.json());
        return Response.json({ event_id: "ll-post-1" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "penumbra-hook-ll-post-"));
  writeFileSync(join(root, "port"), `${String(server.port)}\n`);
  writeFileSync(join(root, "token"), "tk\n");

  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";

  try {
    const exit = await runHook({
      storageRoot: root,
      rawEvent: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_response: { ok: true },
        session_id: "cc-long-lived-post-1",
      }),
      project: null,
      sessionId: null,
    });
    expect(exit).toBe(0);
    expect(triggerCalls).toHaveLength(0);
    expect(observationCalls).toHaveLength(1);
  } finally {
    if (oldTickId === undefined) delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
    else process.env.PENUMBRA_LONG_LIVED_TICK_ID = oldTickId;
    if (oldAgentId === undefined) delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
    else process.env.PENUMBRA_LONG_LIVED_AGENT_ID = oldAgentId;
    if (oldEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntrypoint;
    void server.stop(true);
  }
});

test("runHook forwards SessionStart lifecycle and prints additional context outside long-lived ticks", async () => {
  const oldTickId = process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  const oldAgentId = process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  const oldEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const triggerCalls: TriggerCall[] = [];
  const stdoutChunks: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/workflows/trigger") {
        triggerCalls.push((await req.json()) as TriggerCall);
        return Response.json({ matched: [], additionalContext: "PRIME" });
      }
      if (url.pathname === "/sessions/touch") {
        return Response.json({});
      }
      return new Response("not found", { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "penumbra-hook-start-"));
  writeFileSync(join(root, "port"), `${String(server.port)}\n`);
  writeFileSync(join(root, "token"), "tk\n");

  delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
  const restoreStdoutWrite = stubStdoutWrite(stdoutChunks);

  try {
    const exit = await runHook({
      storageRoot: root,
      rawEvent: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "cc-start-1",
      }),
      project: null,
      sessionId: null,
    });
    expect(exit).toBe(0);
    expect(process.env.PENUMBRA_LONG_LIVED_TICK_ID).toBeUndefined();
    expect(process.env.PENUMBRA_LONG_LIVED_AGENT_ID).toBeUndefined();
    expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBe("cli");
    expect(triggerCalls).toHaveLength(1);
    expect(stdoutChunks.join("")).toContain('"additionalContext":"PRIME"');
  } finally {
    if (oldTickId === undefined) delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
    else process.env.PENUMBRA_LONG_LIVED_TICK_ID = oldTickId;
    if (oldAgentId === undefined) delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
    else process.env.PENUMBRA_LONG_LIVED_AGENT_ID = oldAgentId;
    if (oldEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntrypoint;
    restoreStdoutWrite();
    void server.stop(true);
  }
});

test("runHook forwards transcript_path for Stop lifecycle events", async () => {
  const oldEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const triggerCalls: TriggerCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/workflows/trigger") {
        triggerCalls.push((await req.json()) as TriggerCall);
        return Response.json({ matched: [], additionalContext: null });
      }
      if (url.pathname === "/sessions/touch") {
        return Response.json({});
      }
      return new Response("not found", { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "penumbra-hook-stop-"));
  writeFileSync(join(root, "port"), `${String(server.port)}\n`);
  writeFileSync(join(root, "token"), "tk\n");

  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";

  try {
    const exit = await runHook({
      storageRoot: root,
      rawEvent: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "cc-stop-1",
        transcript_path: "/tmp/cc-session-transcript.log",
      }),
      project: null,
      sessionId: null,
    });
    expect(exit).toBe(0);
    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0]!.transcript_path).toBe("/tmp/cc-session-transcript.log");
    expect(triggerCalls[0]!.session_id).toBe("cc-stop-1");
    expect(triggerCalls[0]!.event.event).toBe("stop");
  } finally {
    if (oldEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntrypoint;
    void server.stop(true);
  }
});

test("classifyOrigin tags conv- session_id as dispatch", () => {
  expect(classifyOrigin("conv-7f3a-...")).toBe("dispatch");
});

test("classifyOrigin tags UUID-shaped session_id as maestro", () => {
  expect(classifyOrigin("a1b2c3d4-1111-2222-3333-444455556666")).toBe("maestro");
});

test("classifyOrigin returns unknown for null/empty/non-matching", () => {
  expect(classifyOrigin(null)).toBe("unknown");
  expect(classifyOrigin("")).toBe("unknown");
  expect(classifyOrigin("cc-session-1")).toBe("unknown");
});

test("mapClaudeCodeEvent stamps origin=maestro for UUID sessions", () => {
  const ev = mapClaudeCodeEvent(
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "hi",
      session_id: "a1b2c3d4-1111-2222-3333-444455556666",
    },
    { project: null, sessionId: null },
  );
  expect(ev!.origin).toBe("maestro");
});

test("mapClaudeCodeEvent stamps origin=dispatch for conv- sessions", () => {
  const ev = mapClaudeCodeEvent(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      session_id: "conv-abc123",
    },
    { project: null, sessionId: null },
  );
  expect(ev!.origin).toBe("dispatch");
});

test("mapClaudeCodeEvent stamps origin=unknown when session_id is missing", () => {
  const ev = mapClaudeCodeEvent(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: {},
    },
    { project: null, sessionId: null },
  );
  expect(ev!.origin).toBe("unknown");
});

test("runHook returns 0 (best-effort) when the daemon is unreachable", async () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-hook-test-"));
  writeFileSync(join(root, "port"), "1\n"); // unlikely-bound port
  writeFileSync(join(root, "token"), "tk\n");

  const exit = await runHook({
    storageRoot: root,
    rawEvent: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" }),
    project: null,
    sessionId: null,
  });
  expect(exit).toBe(0);
});
