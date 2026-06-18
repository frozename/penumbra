import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ShellSessionPool } from "../../src/services/shell-session-pool.js";

type RuntimeShellConfig = ConstructorParameters<typeof ShellSessionPool>[0]["config"];

function makeConfig(overrides: Partial<RuntimeShellConfig> = {}): RuntimeShellConfig {
  const baseDangerous = ["sudo\\b"];
  return {
    enabled: true,
    maxSessionsPerHandoff: 4,
    maxConcurrentRunsPerSession: 1,
    maxSessionIdleMs: 600000,
    maxCommandDurationMs: 5000,
    outputByteLimit: 16384,
    redactOutput: true,
    unsetEnv: [],
    dangerousCommands: baseDangerous,
    dangerousCommandsForAgent: () => baseDangerous,
    redactOutputForAgent: () => true,
    ...overrides,
  };
}

describe("ShellSessionPool", () => {
  let pool: ShellSessionPool;

  beforeEach(() => {
    pool = new ShellSessionPool({
      config: makeConfig(),
      uuid: () => `sess-${Math.random().toString(36).slice(2, 8)}`,
    });
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  it("createSession launches bash and returns a session id", async () => {
    const { sessionId } = await pool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });
    expect(sessionId).toBeTruthy();
    const sessions = pool.listSessions("h-1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.cwd).toBe("/tmp");
  });

  it("runCommand returns stdout/stderr/exit_code for a simple command", async () => {
    const { sessionId } = await pool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });
    const result = await pool.runCommand({ handoffId: "h-1", sessionId, command: "echo hi" });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.stderr).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("persists state across runCommand calls (cd then pwd)", async () => {
    const { sessionId } = await pool.createSession({
      handoffId: "h-1",
      cwd: "/",
      env: {},
      pty: false,
    });
    await pool.runCommand({ handoffId: "h-1", sessionId, command: "cd /tmp" });
    const result = await pool.runCommand({ handoffId: "h-1", sessionId, command: "pwd" });
    expect(result.stdout.trim()).toBe("/tmp");
  });

  it("serializes concurrent runCommand against the same session", async () => {
    const { sessionId } = await pool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });
    const a = pool.runCommand({ handoffId: "h-1", sessionId, command: "echo first" });
    const b = pool.runCommand({ handoffId: "h-1", sessionId, command: "echo second" });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.stdout).toBe("first\n");
    expect(rb.stdout).toBe("second\n");
  });

  it("clears all created setTimeouts during a fast command execution", async () => {
    const { sessionId } = await pool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    const activeTimeouts = new Set<any>();

    global.setTimeout = ((...args: any[]) => {
      const id = (originalSetTimeout as any)(...args);
      activeTimeouts.add(id);
      return id;
    }) as any;

    global.clearTimeout = (id: any) => {
      activeTimeouts.delete(id);
      originalClearTimeout(id);
    };

    try {
      const result = await pool.runCommand({ handoffId: "h-1", sessionId, command: "echo fast" });
      expect(result.exit_code).toBe(0);
      // Let the promise race settle fully
      await new Promise((r) => originalSetTimeout(r, 0));
      expect(activeTimeouts.size).toBe(0);
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      for (const id of activeTimeouts) {
        originalClearTimeout(id);
      }
    }
  });

  it("returns exit_code 124 on per-command timeout and keeps session alive", async () => {
    const cfg = makeConfig({ maxCommandDurationMs: 200 });
    const localPool = new ShellSessionPool({ config: cfg, uuid: () => "sess-t1" });
    const { sessionId } = await localPool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });
    const result = await localPool.runCommand({ handoffId: "h-1", sessionId, command: "sleep 5" });
    expect(result.exit_code).toBe(124);
    const post = await localPool.runCommand({ handoffId: "h-1", sessionId, command: "echo alive" });
    expect(post.stdout).toBe("alive\n");
    await localPool.shutdown();
  });

  it("truncates output at outputByteLimit and sets truncated=true", async () => {
    const cfg = makeConfig({ outputByteLimit: 32 });
    const localPool = new ShellSessionPool({ config: cfg, uuid: () => "sess-trunc" });
    const { sessionId } = await localPool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });
    const result = await localPool.runCommand({
      handoffId: "h-1",
      sessionId,
      command: 'printf %s "$(yes a | head -c 256 | tr -d "\\n")"',
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(32);
    await localPool.shutdown();
  });

  it("redacts api keys, github tokens, discord webhooks, and bearer tokens from stdout", async () => {
    const { sessionId } = await pool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });
    const result = await pool.runCommand({
      handoffId: "h-1",
      sessionId,
      command:
        "echo sk-test123ABCDEF1234567890; echo ghp_abcdef1234567890XYZA; echo https://discord.com/api/webhooks/12345/abcdef_-XYZ; echo Bearer xyz.abc-123",
    });
    expect(result.stdout).not.toContain("sk-test123");
    expect(result.stdout).not.toContain("ghp_abcdef");
    expect(result.stdout).not.toContain("webhooks/12345");
    expect(result.stdout).not.toContain("xyz.abc-123");
    expect((result.stdout.match(/\[REDACTED\]/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("closeSession terminates the subprocess and subsequent runCommand returns exit_code -1", async () => {
    const { sessionId } = await pool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });
    await pool.closeSession({ handoffId: "h-1", sessionId });
    const result = await pool.runCommand({ handoffId: "h-1", sessionId, command: "echo hi" });
    expect(result.exit_code).toBe(-1);
    expect(result.stderr).toContain("session ended");
  });

  it("rejects creation past maxSessionsPerHandoff with a typed error", async () => {
    const cfg = makeConfig({ maxSessionsPerHandoff: 2 });
    const localPool = new ShellSessionPool({
      config: cfg,
      uuid: (() => {
        let i = 0;
        return () => `sess-${++i}`;
      })(),
    });
    await localPool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false });
    await localPool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false });
    await expect(
      localPool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false }),
    ).rejects.toThrow(/max sessions/i);
    await localPool.shutdown();
  });

  it("reapHandoff kills all sessions for a handoff", async () => {
    await pool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false });
    await pool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false });
    await pool.createSession({ handoffId: "h-2", cwd: "/tmp", env: {}, pty: false });
    await pool.reapHandoff("h-1");
    expect(pool.listSessions("h-1")).toHaveLength(0);
    expect(pool.listSessions("h-2")).toHaveLength(1);
  });
});

describe("ShellSessionPool — PTY mode", () => {
  it("strips ANSI escape sequences from PTY output", async () => {
    const pool = new ShellSessionPool({ config: makeConfig(), uuid: () => "sess-pty" });
    let session;
    try {
      const created = await pool.createSession({
        handoffId: "h-1",
        cwd: "/tmp",
        env: {},
        pty: true,
      });
      session = created.sessionId;
    } catch (err) {
      if (String(err).includes("pty unavailable")) {
        return; // skip when PTY is not supported on this host
      }
      throw err;
    }
    const result = await pool.runCommand({
      handoffId: "h-1",
      sessionId: session,
      command: `printf '\\x1b[31mred\\x1b[0m'`,
    });
    expect(result.stdout).toBe("red");
    await pool.shutdown();
  });
});

describe("ShellSessionPool — sweeping", () => {
  it("reapTerminalHandoffs reaps sessions for handoffs in terminal state", async () => {
    let status: "pending" | "completed" = "pending";
    const pool = new ShellSessionPool({
      config: makeConfig(),
      uuid: () => "sess-sweep",
      handoffStatusReader: { getStatus: async () => status },
    });
    await pool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false });
    expect(pool.listSessions("h-1")).toHaveLength(1);
    status = "completed";
    await pool.reapTerminalHandoffs();
    expect(pool.listSessions("h-1")).toHaveLength(0);
    await pool.shutdown();
  });

  it("reapIdleSessions reaps sessions whose last_used_at is older than max_session_idle_ms", async () => {
    let now = new Date("2026-05-01T10:00:00Z");
    const pool = new ShellSessionPool({
      config: makeConfig({ maxSessionIdleMs: 1000 }),
      uuid: () => "sess-idle",
      now: () => now,
    });
    await pool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false });
    now = new Date("2026-05-01T10:00:02Z");
    await pool.reapIdleSessions();
    expect(pool.listSessions("h-1")).toHaveLength(0);
    await pool.shutdown();
  });
});
