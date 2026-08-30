import { buildScrubbedChildEnv, ShellSessionPool } from "@src/services/shell-session-pool.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

// bun:test's `.rejects.toThrow()` is typed as void even though it awaits the
// underlying promise at runtime. Use this helper instead.
async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
    expect(String(err)).toMatch(pattern);
  }
  expect(threw).toBe(true);
}

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
    dangerousCommandsForAgent: (): string[] => baseDangerous,
    redactOutputForAgent: (): boolean => true,
    ...overrides,
  };
}

describe("ShellSessionPool", () => {
  let pool: ShellSessionPool;

  beforeEach(() => {
    pool = new ShellSessionPool({
      config: makeConfig(),
      uuid: (): string => `sess-${Math.random().toString(36).slice(2, 8)}`,
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

    type TimeoutId = ReturnType<typeof setTimeout>;

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    const activeTimeouts = new Set<TimeoutId>();

    const trackedSetTimeout = (...args: Parameters<typeof setTimeout>): TimeoutId => {
      const id = originalSetTimeout(...args);
      activeTimeouts.add(id);
      return id;
    };
    global.setTimeout = trackedSetTimeout as typeof setTimeout;

    const trackedClearTimeout = (id?: TimeoutId): void => {
      if (id !== undefined) activeTimeouts.delete(id);
      originalClearTimeout(id);
    };
    global.clearTimeout = trackedClearTimeout as typeof clearTimeout;

    try {
      const result = await pool.runCommand({ handoffId: "h-1", sessionId, command: "echo fast" });
      expect(result.exit_code).toBe(0);
      // Let the promise race settle fully
      await new Promise<void>((r) => originalSetTimeout(r, 0));
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
    const localPool = new ShellSessionPool({ config: cfg, uuid: (): string => "sess-t1" });
    const { sessionId } = await localPool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });
    const result = await localPool.runCommand({ handoffId: "h-1", sessionId, command: "sleep 5" });
    expect(result.exit_code).toBe(124);
    const post = await localPool.runCommand({
      handoffId: "h-1",
      sessionId,
      command: "echo alive",
    });
    expect(post.stdout).toBe("alive\n");
    await localPool.shutdown();
  });

  it("truncates output at outputByteLimit and sets truncated=true", async () => {
    const cfg = makeConfig({ outputByteLimit: 32 });
    const localPool = new ShellSessionPool({ config: cfg, uuid: (): string => "sess-trunc" });
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

  it("bounds the live capture buffer for high-volume output (does not buffer unbounded)", async () => {
    const cfg = makeConfig({ outputByteLimit: 1024 });
    const localPool = new ShellSessionPool({ config: cfg, uuid: (): string => "sess-live" });
    const { sessionId } = await localPool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });

    const internal = localPool as unknown as {
      handoffs: Map<string, Map<string, { stdoutBuffer: string }>>;
    };

    try {
      const runPromise = localPool.runCommand({
        handoffId: "h-1",
        sessionId,
        command: "yes a | head -c 2000000; sleep 1",
      });

      let maxLiveLen = 0;
      const start = Date.now();
      while (Date.now() - start < 1500) {
        const liveState = internal.handoffs.get("h-1")?.get(sessionId);
        if (liveState) {
          maxLiveLen = Math.max(maxLiveLen, liveState.stdoutBuffer.length);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }

      const result = await runPromise;

      expect(maxLiveLen).toBeLessThan(64 * 1024);
      expect(result.exit_code).toBe(0);
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1024);
    } finally {
      await localPool.shutdown();
    }
  });

  it("parses commands after residual output already fills the live buffer", async () => {
    const cfg = makeConfig({ maxCommandDurationMs: 800, outputByteLimit: 1024 });
    const localPool = new ShellSessionPool({ config: cfg, uuid: (): string => "sess-residual" });
    const { sessionId } = await localPool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });

    const internal = localPool as unknown as {
      handoffs: Map<string, Map<string, { stdoutBuffer: string }>>;
    };
    const liveState = internal.handoffs.get("h-1")?.get(sessionId);
    expect(liveState).toBeDefined();
    liveState!.stdoutBuffer = "r".repeat(17 * 1024);

    try {
      const result = await localPool.runCommand({
        handoffId: "h-1",
        sessionId,
        command: "yes a | head -c 2000000",
      });

      expect(result.exit_code).toBe(0);
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1024);
    } finally {
      await localPool.shutdown();
    }
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

  it("redacts newer provider credential shapes from stdout", async () => {
    const { sessionId } = await pool.createSession({
      handoffId: "h-1",
      cwd: "/tmp",
      env: {},
      pty: false,
    });
    const result = await pool.runCommand({
      handoffId: "h-1",
      sessionId,
      command: "echo gsk_abcdefghijklmnopqrstuvwxyz012345",
    });
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("gsk_abcdefghijklmnopqrstuvwxyz012345");
  });

  it("buildScrubbedChildEnv keeps allowlisted vars, drops parent secrets, and lets extraEnv override", () => {
    const prevPath = process.env.PATH;
    const prevSomeSecret = process.env.SOME_SECRET;
    process.env.PATH = "/usr/bin:/bin";
    process.env.SOME_SECRET = "custom-parent-secret";
    try {
      const env = buildScrubbedChildEnv([], { PATH: "/custom/bin", CUSTOM_ALLOWED: "from-extra" });

      expect(env.PATH).toBe("/custom/bin");
      expect(env.SOME_SECRET).toBeUndefined();
      expect(env.CUSTOM_ALLOWED).toBe("from-extra");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevSomeSecret === undefined) delete process.env.SOME_SECRET;
      else process.env.SOME_SECRET = prevSomeSecret;
    }
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
        return (): string => `sess-${String(++i)}`;
      })(),
    });
    await localPool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false });
    await localPool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false });
    await expectRejection(
      localPool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false }),
      /max sessions/i,
    );
    await localPool.shutdown();
  });

  it("concurrent close during replaceTimedOutProcess does not resurrect the session", async () => {
    const cfg = makeConfig({ maxCommandDurationMs: 5000 });
    const localPool = new ShellSessionPool({ config: cfg, uuid: (): string => "sess-race" });
    const { sessionId } = await localPool.createSession({
      handoffId: "h-race",
      cwd: "/tmp",
      env: {},
      pty: false,
    });

    interface InternalState {
      dead: boolean;
      proc: { exitCode: number | null; exited: Promise<number>; kill: (sig?: string) => void };
      handoffId: string;
      sessionId: string;
      launchEnv: Record<string, string>;
      cwd: string;
      pty: boolean;
    }
    const internal = localPool as unknown as {
      handoffs: Map<string, Map<string, InternalState>>;
      replaceTimedOutProcess(state: InternalState): Promise<void>;
    };

    const state = internal.handoffs.get("h-race")!.get(sessionId)!;
    expect(state.dead).toBe(false);

    // Kick off replaceTimedOutProcess concurrently with closeSession. closeSession
    // synchronously sets state.dead=true and deletes the map entry before its first
    // await, so when replaceTimedOutProcess resumes it should observe the deletion
    // and NOT resurrect state.dead to false or leave an orphan replacement process.
    const replacePromise = internal.replaceTimedOutProcess(state);
    const closePromise = localPool.closeSession({ handoffId: "h-race", sessionId });
    await Promise.all([replacePromise, closePromise]);

    expect(state.dead).toBe(true);
    expect(internal.handoffs.get("h-race")).toBeUndefined();
    expect(localPool.listSessions("h-race")).toHaveLength(0);

    // The now-current state.proc must be terminated (either the original oldProc
    // that closeSession killed, or a replacement that replaceTimedOutProcess
    // SIGKILLed after observing the concurrent close). Await its exit with a
    // bounded timeout so an orphaned live shell would be detected reliably.
    const exitedWithin = await Promise.race([
      state.proc.exited.then(() => true),
      new Promise<boolean>((r) =>
        setTimeout(() => {
          r(false);
        }, 2000),
      ),
    ]);
    expect(exitedWithin).toBe(true);

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
    const pool = new ShellSessionPool({ config: makeConfig(), uuid: (): string => "sess-pty" });
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
      uuid: (): string => "sess-sweep",
      handoffStatusReader: {
        getStatus(_handoffId: string): Promise<string | null> {
          return Promise.resolve(status);
        },
      },
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
      uuid: (): string => "sess-idle",
      now: (): Date => now,
    });
    await pool.createSession({ handoffId: "h-1", cwd: "/tmp", env: {}, pty: false });
    now = new Date("2026-05-01T10:00:02Z");
    await pool.reapIdleSessions();
    expect(pool.listSessions("h-1")).toHaveLength(0);
    await pool.shutdown();
  });
});
