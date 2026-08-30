import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchWorkflowSubcommand } from "../../src/commands/workflow.js";

const TOKEN = "test-token";

async function expectRejectsToMatch(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (err) {
    caught = err;
    rejected = true;
  }
  expect(rejected).toBe(true);
  expect(caught instanceof Error ? caught.message : String(caught)).toMatch(pattern);
}

interface SeenRequest {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

const seen: SeenRequest[] = [];
let server: ReturnType<typeof Bun.serve>;
let storageRoot: string;
let stdoutLines: string[] = [];
let stderrLines: string[] = [];
let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">>;
let consoleErrorSpy: ReturnType<typeof spyOn<typeof console, "error">>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        auth: req.headers.get("authorization"),
        body: req.method === "POST" ? await req.json() : undefined,
      });
      if (url.pathname === "/workflows/list") {
        return Response.json({
          workflows: [{ name: "demo", description: "demo workflow", triggers: [{ kind: "cron" }] }],
        });
      }
      if (url.pathname === "/workflows/run") return Response.json({ outcome: "success" });
      if (url.pathname === "/workflows/history") {
        if (url.searchParams.get("name") === "boom") return new Response("boom", { status: 500 });
        return Response.json({ runs: [] });
      }
      if (url.pathname === "/workflows/suggest") return Response.json({ suggestions: [] });
      return new Response("not found", { status: 404 });
    },
  });
  storageRoot = mkdtempSync(join(tmpdir(), "penumbra-workflow-dispatch-"));
  writeFileSync(join(storageRoot, "port"), String(server.port), "utf8");
  writeFileSync(join(storageRoot, "token"), TOKEN, "utf8");
});

afterAll(() => {
  void server.stop(true);
  rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  stdoutLines = [];
  stderrLines = [];
  stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutLines.push(String(chunk));
    return true;
  });
  consoleErrorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe("dispatchWorkflowSubcommand", () => {
  test("no subcommand prints usage and returns 2", async () => {
    const stderrWriteSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    try {
      const code = await dispatchWorkflowSubcommand([], storageRoot);
      expect(code).toBe(2);
      expect(stderrLines.join("")).toContain("usage: penumbra workflow");
    } finally {
      stderrWriteSpy.mockRestore();
    }
  });

  test("unknown subcommand returns 2", async () => {
    const code = await dispatchWorkflowSubcommand(["bogus"], storageRoot);
    expect(code).toBe(2);
    expect(stderrLines.join("")).toContain("usage: penumbra workflow");
  });

  test("list fetches from the daemon with the bearer token", async () => {
    const code = await dispatchWorkflowSubcommand(["list"], storageRoot);
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/workflows/list");
    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(stdoutLines.join("")).toContain("demo\tdemo workflow");
    expect(stdoutLines.join("")).not.toContain("trigger:");
  });

  test("list --triggers also prints trigger definitions", async () => {
    const code = await dispatchWorkflowSubcommand(["list", "--triggers"], storageRoot);
    expect(code).toBe(0);
    expect(stdoutLines.join("")).toContain('trigger: {"kind":"cron"}');
  });

  test("run without a name returns 2", async () => {
    const code = await dispatchWorkflowSubcommand(["run"], storageRoot);
    expect(code).toBe(2);
    expect(stderrLines.join("")).toContain("usage: penumbra workflow run");
    expect(seen).toHaveLength(0);
  });

  test("run --dry-run does not contact the daemon", async () => {
    const code = await dispatchWorkflowSubcommand(["run", "demo", "--dry-run"], storageRoot);
    expect(code).toBe(0);
    expect(stdoutLines.join("")).toContain("(dry-run) would run demo");
    expect(seen).toHaveLength(0);
  });

  test("run posts name and --session-id to /workflows/run", async () => {
    const code = await dispatchWorkflowSubcommand(
      ["run", "demo", "--session-id", "sess-42"],
      storageRoot,
    );
    expect(code).toBe(0);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.path).toBe("/workflows/run");
    expect(seen[0]?.body).toEqual({ name: "demo", session_id: "sess-42" });
    expect(stdoutLines.join("")).toContain('"outcome": "success"');
  });

  test("history without a name returns 2", async () => {
    const code = await dispatchWorkflowSubcommand(["history"], storageRoot);
    expect(code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  test("history URL-encodes the workflow name", async () => {
    const code = await dispatchWorkflowSubcommand(["history", "a b"], storageRoot);
    expect(code).toBe(0);
    expect(seen[0]?.path).toBe("/workflows/history?name=a%20b");
  });

  test("suggest posts to /workflows/suggest", async () => {
    const code = await dispatchWorkflowSubcommand(["suggest"], storageRoot);
    expect(code).toBe(0);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.path).toBe("/workflows/suggest");
  });

  test("a non-2xx daemon response rejects with the path and status", async () => {
    await expectRejectsToMatch(
      dispatchWorkflowSubcommand(["history", "boom"], storageRoot),
      /workflows\/history\?name=boom → 500/,
    );
  });

  test("an invalid daemon port file rejects", async () => {
    const badRoot = mkdtempSync(join(tmpdir(), "penumbra-workflow-badport-"));
    try {
      writeFileSync(join(badRoot, "port"), "not-a-port", "utf8");
      writeFileSync(join(badRoot, "token"), TOKEN, "utf8");
      await expectRejectsToMatch(
        dispatchWorkflowSubcommand(["suggest"], badRoot),
        /invalid daemon port/,
      );
    } finally {
      rmSync(badRoot, { recursive: true, force: true });
    }
  });

  test("an empty daemon token rejects", async () => {
    const badRoot = mkdtempSync(join(tmpdir(), "penumbra-workflow-badtoken-"));
    try {
      writeFileSync(join(badRoot, "port"), String(server.port), "utf8");
      writeFileSync(join(badRoot, "token"), "", "utf8");
      await expectRejectsToMatch(
        dispatchWorkflowSubcommand(["suggest"], badRoot),
        /empty daemon token/,
      );
    } finally {
      rmSync(badRoot, { recursive: true, force: true });
    }
  });
});
