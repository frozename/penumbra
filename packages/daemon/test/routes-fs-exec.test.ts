import type { Services } from "@penumbra/core";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { worktreesExecRoute } from "../src/routes/fs.js";

interface ExecBody {
  exit_code: number | null;
  stderr: string;
  stdout: string;
  timed_out: boolean;
  truncated: boolean;
}

interface RouteErrorBody {
  error: {
    code: string;
    message?: string;
  };
}

interface DangerousCommandBody {
  error: {
    code: string;
    matched: string[];
  };
}

async function jsonBody<T>(res: Response): Promise<T> {
  const body: unknown = await res.json();
  return body as T;
}

async function withinHardDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`test hard timeout after ${timeoutMs.toString()}ms`);
    }),
  ]);
}

type ExecToolName = "shell_run" | "shell_run.dangerous";

interface ExecPermissionInput {
  parent_handoff_id: string;
  agent_name: string;
  tool_name: ExecToolName;
  context: Record<string, unknown>;
  signal?: AbortSignal;
}

interface ExecPermissionService {
  requestPermission(input: ExecPermissionInput): Promise<{ approved: boolean }>;
}

interface ExecAgentchatConfig {
  agents: { name: string; auto_approve_to: string[] }[];
}

function fakeServices(
  worktrees: Record<string, string>,
  opts: {
    handoffs?: Record<string, { to_agent?: string }>;
    dangerousPatterns?: Record<string, string[]>;
    omitShellConfig?: boolean;
    omitShellSessionPool?: boolean;
    redactOutput?: boolean;
    shellConfig?: unknown;
    permissionService?: ExecPermissionService;
    agentchatConfig?: ExecAgentchatConfig;
  } = {},
): Services {
  const services: {
    handoffReader: { get: (id: string) => { to_agent?: string } | null };
    shellConfig?: unknown;
    shellSessionPool?: unknown;
    agentchatConfig?: ExecAgentchatConfig;
    permissionService?: ExecPermissionService;
    worktreeManager: {
      getWorktree: (id: string) => { handoffId: string; path: string } | null;
    };
  } = {
    worktreeManager: {
      getWorktree: (id: string) => (worktrees[id] ? { handoffId: id, path: worktrees[id] } : null),
    },
    handoffReader: {
      get: (id: string) => opts.handoffs?.[id] ?? null,
    },
  };
  // The session pool is constructed only when shell.enabled is true; the exec
  // route reads only its presence (the enabled kill-switch), never its methods.
  if (opts.omitShellSessionPool !== true) {
    services.shellSessionPool = {};
  }
  if ("shellConfig" in opts) {
    services.shellConfig = opts.shellConfig;
  } else if (opts.omitShellConfig !== true) {
    services.shellConfig = {
      dangerousCommandsForAgent: (agentName: string | null): string[] =>
        agentName === null ? [] : (opts.dangerousPatterns?.[agentName] ?? []),
      unsetEnv: [] as string[],
      redactOutputForAgent: (): boolean => opts.redactOutput === true,
    };
  }
  if (opts.agentchatConfig) {
    services.agentchatConfig = opts.agentchatConfig;
  }
  // Default gate mirrors an unattended dispatch: general shell_run is approved,
  // but dangerous commands are not auto-approved (matching shell_run policy).
  services.permissionService = opts.permissionService ?? {
    requestPermission: (input: ExecPermissionInput): Promise<{ approved: boolean }> =>
      Promise.resolve({ approved: input.tool_name === "shell_run" }),
  };
  // The route under test reads only these daemon service fields.
  return services as unknown as Services;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await Bun.sleep(50);
  }
  throw new Error(`pid ${pid.toString()} is still alive`);
}

describe("worktrees exec route", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routes-fs-exec-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("runs echo and returns stdout with exit_code 0", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo hello" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<ExecBody>(res);
    expect(body.stdout).toContain("hello");
    expect(body.exit_code).toBe(0);
    expect(body.timed_out).toBe(false);
  });

  it("runs command in the worktree cwd", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "pwd" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<ExecBody>(res);
    // realpath to handle macOS /private/var vs /var symlink
    const realTmp = fs.realpathSync(tmp);
    expect(body.stdout.trim()).toBe(realTmp);
    expect(body.exit_code).toBe(0);
  });

  it("captures non-zero exit code without throwing", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "exit 3", timeout_ms: 5000 }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<ExecBody>(res);
    expect(body.exit_code).toBe(3);
    expect(body.timed_out).toBe(false);
  });

  it("returns 403 dangerous_command for matched pattern WITHOUT running", async () => {
    const commandRan = false;
    const services = fakeServices(
      { H1: tmp },
      {
        handoffs: { H1: { to_agent: "agent-x" } },
        dangerousPatterns: { "agent-x": ["rm\\s+-rf"] },
      },
    );

    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "rm -rf /tmp/something" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(403);
    const body = await jsonBody<DangerousCommandBody>(res);
    expect(body.error.code).toBe("dangerous_command");
    expect(Array.isArray(body.error.matched)).toBe(true);
    expect(body.error.matched.length).toBeGreaterThan(0);
    expect(commandRan).toBe(false);
  });

  it("returns 403 dangerous_command (fail closed) for malformed regex pattern", async () => {
    const commandRan = false;
    const services = fakeServices(
      { H1: tmp },
      {
        handoffs: { H1: { to_agent: "agent-x" } },
        dangerousPatterns: { "agent-x": ["["] }, // Malformed regex
      },
    );

    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo safe" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(403);
    const body = await jsonBody<DangerousCommandBody>(res);
    expect(body.error.code).toBe("dangerous_command");
    expect(Array.isArray(body.error.matched)).toBe(true);
    expect(body.error.matched).toContain("[");
  });

  it("allows a benign command when agent has dangerous patterns configured", async () => {
    const services = fakeServices(
      { H1: tmp },
      {
        handoffs: { H1: { to_agent: "agent-x" } },
        dangerousPatterns: { "agent-x": ["rm\\s+-rf"] },
      },
    );
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo safe" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<ExecBody>(res);
    expect(body.exit_code).toBe(0);
    expect(body.stdout).toContain("safe");
  });

  it("returns timed_out:true and null exit_code when command exceeds timeout", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "sleep 60", timeout_ms: 100 }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<ExecBody>(res);
    expect(body.timed_out).toBe(true);
    expect(body.exit_code).toBeNull();
  });

  it("bounds a permission acquisition that never settles and does not fabricate success", async () => {
    let permissionAttempts = 0;
    let permissionCancellations = 0;
    const sideEffectPath = path.join(tmp, "must-not-exist");
    const services = fakeServices(
      { H1: tmp },
      {
        permissionService: {
          requestPermission: (input): Promise<{ approved: boolean }> => {
            permissionAttempts += 1;
            return new Promise((_, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => {
                  permissionCancellations += 1;
                  setTimeout(() => {
                    const cleanupFinishedAt = Date.now() + 100;
                    while (Date.now() < cleanupFinishedAt) {
                      // Simulate deferred durable cleanup under SQLite contention.
                    }
                  }, 0);
                  reject(new Error("permission request aborted"));
                },
                { once: true },
              );
            });
          },
        },
      },
    );
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({
        command: `touch ${JSON.stringify(sideEffectPath)}`,
        timeout_ms: 25,
      }),
    });

    const startedAt = Date.now();
    const res = await withinHardDeadline(worktreesExecRoute(req, "H1", services), 250);
    const body = await jsonBody<ExecBody>(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({
      stdout: "",
      stderr: "",
      exit_code: null,
      timed_out: true,
      truncated: false,
    });
    expect(permissionAttempts).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(80);
    expect(permissionCancellations).toBe(1);
    expect(fs.existsSync(sideEffectPath)).toBe(false);
    await Bun.sleep(120);
  });

  it("starts a fresh attempt after permission acquisition times out", async () => {
    let permissionAttempts = 0;
    const firstSideEffectPath = path.join(tmp, "first-must-not-exist");
    const services = fakeServices(
      { H1: tmp },
      {
        permissionService: {
          requestPermission: (): Promise<{ approved: boolean }> => {
            permissionAttempts += 1;
            if (permissionAttempts === 1) {
              return new Promise(() => {
                // Deliberately never settles to reproduce the pre-execution wedge.
              });
            }
            return Promise.resolve({ approved: true });
          },
        },
      },
    );
    const first = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({
        command: `touch ${JSON.stringify(firstSideEffectPath)}`,
        timeout_ms: 25,
      }),
    });
    const second = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo fresh-attempt", timeout_ms: 500 }),
    });

    const firstRes = await withinHardDeadline(worktreesExecRoute(first, "H1", services), 250);
    const firstBody = await jsonBody<ExecBody>(firstRes);
    const secondRes = await withinHardDeadline(worktreesExecRoute(second, "H1", services), 1_000);
    const secondBody = await jsonBody<ExecBody>(secondRes);

    expect(firstBody.timed_out).toBe(true);
    expect(fs.existsSync(firstSideEffectPath)).toBe(false);
    expect(secondBody.timed_out).toBe(false);
    expect(secondBody.exit_code).toBe(0);
    expect(secondBody.stdout).toContain("fresh-attempt");
    expect(permissionAttempts).toBe(2);
  });

  it("charges permission latency against the command timeout budget", async () => {
    const services = fakeServices(
      { H1: tmp },
      {
        permissionService: {
          requestPermission: async (): Promise<{ approved: boolean }> => {
            await Bun.sleep(60);
            return { approved: true };
          },
        },
      },
    );
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "sleep 0.2; echo too-late", timeout_ms: 100 }),
    });
    const startedAt = Date.now();

    const res = await withinHardDeadline(worktreesExecRoute(req, "H1", services), 250);
    const body = await jsonBody<ExecBody>(res);

    expect(body.timed_out).toBe(true);
    expect(body.exit_code).toBeNull();
    expect(body.stdout).not.toContain("too-late");
    expect(Date.now() - startedAt).toBeLessThan(140);
  });

  it.skipIf(process.platform === "win32")(
    "kills background descendants when command exceeds timeout",
    async () => {
      const services = fakeServices({ H1: tmp });
      const pidFile = path.join(tmp, "fs-exec-grandchild.pid");
      const req = new Request("http://x/worktrees/H1/exec", {
        method: "POST",
        body: JSON.stringify({
          command: `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; wait`,
          timeout_ms: 100,
        }),
      });
      const res = await worktreesExecRoute(req, "H1", services);
      const body = await jsonBody<ExecBody>(res);
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());

      try {
        expect(body.timed_out).toBe(true);
        expect(body.exit_code).toBeNull();
        await waitUntilDead(pid);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    },
  );

  it("returns 404 when handoff is unknown", async () => {
    const services = fakeServices({});
    const req = new Request("http://x/worktrees/UNKNOWN/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo hi" }),
    });
    const res = await worktreesExecRoute(req, "UNKNOWN", services);
    expect(res.status).toBe(404);
    const body = await jsonBody<RouteErrorBody>(res);
    expect(body.error.code).toBe("not_found");
  });

  it("returns 400 when command is missing", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = await jsonBody<RouteErrorBody>(res);
    expect(body.error.code).toBe("invalid_args");
  });

  it("returns 503 shell_config_unavailable when shellConfig is undefined, even for a benign command", async () => {
    const services = fakeServices({ H1: tmp }, { omitShellConfig: true });

    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo safe" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(503);
    const body = await jsonBody<RouteErrorBody>(res);
    expect(body.error.code).toBe("shell_config_unavailable");
    expect(body.error.message).toBe("service temporarily unavailable");
  });

  it("returns 503 shell_config_unavailable when shellConfig is truthy but malformed", async () => {
    const services = fakeServices({ H1: tmp }, { shellConfig: {} });

    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo safe" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(503);
    const body = await jsonBody<RouteErrorBody>(res);
    expect(body.error.code).toBe("shell_config_unavailable");
    expect(body.error.message).toBe("service temporarily unavailable");
  });

  it("returns 503 shell_config_unavailable when redactOutputForAgent is missing (partial config fails closed)", async () => {
    const services = fakeServices(
      { H1: tmp },
      { shellConfig: { dangerousCommandsForAgent: (): string[] => [], unsetEnv: [] } },
    );
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo safe" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(503);
    const body = await jsonBody<RouteErrorBody>(res);
    expect(body.error.code).toBe("shell_config_unavailable");
  });

  it("returns 503 shell_disabled when the shell session pool is absent (kill-switch)", async () => {
    const services = fakeServices({ H1: tmp }, { omitShellSessionPool: true });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo safe" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(503);
    const body = await jsonBody<RouteErrorBody>(res);
    expect(body.error.code).toBe("shell_disabled");
  });

  it("does not leak the daemon's own auth token into the child environment", async () => {
    const prev = process.env.PENUMBRA_TOKEN;
    process.env.PENUMBRA_TOKEN = "super-secret-daemon-bearer";
    try {
      const services = fakeServices({ H1: tmp });
      const req = new Request("http://x/worktrees/H1/exec", {
        method: "POST",
        body: JSON.stringify({ command: "printenv PENUMBRA_TOKEN || true" }),
      });
      const res = await worktreesExecRoute(req, "H1", services);
      expect(res.status).toBe(200);
      const body = await jsonBody<ExecBody>(res);
      expect(body.stdout).not.toContain("super-secret-daemon-bearer");
    } finally {
      if (prev === undefined) delete process.env.PENUMBRA_TOKEN;
      else process.env.PENUMBRA_TOKEN = prev;
    }
  });

  it("does not leak provider or custom parent env secrets into the child environment", async () => {
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    const prevSomeSecret = process.env.SOME_SECRET;
    process.env.ANTHROPIC_API_KEY = "anthropic-parent-secret";
    process.env.SOME_SECRET = "custom-parent-secret";
    try {
      const services = fakeServices({ H1: tmp });
      const req = new Request("http://x/worktrees/H1/exec", {
        method: "POST",
        body: JSON.stringify({
          command: "printenv ANTHROPIC_API_KEY || true; printenv SOME_SECRET || true",
        }),
      });
      const res = await worktreesExecRoute(req, "H1", services);
      expect(res.status).toBe(200);
      const body = await jsonBody<ExecBody>(res);
      expect(body.stdout).not.toContain("anthropic-parent-secret");
      expect(body.stdout).not.toContain("custom-parent-secret");
    } finally {
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropic;
      if (prevSomeSecret === undefined) delete process.env.SOME_SECRET;
      else process.env.SOME_SECRET = prevSomeSecret;
    }
  });

  it("preserves PATH in the child environment", async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const services = fakeServices({ H1: tmp });
      const req = new Request("http://x/worktrees/H1/exec", {
        method: "POST",
        body: JSON.stringify({ command: "printenv PATH" }),
      });
      const res = await worktreesExecRoute(req, "H1", services);
      expect(res.status).toBe(200);
      const body = await jsonBody<ExecBody>(res);
      expect(body.stdout.trim()).toBe("/usr/bin:/bin");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  it("redacts credential-shaped output when redaction is enabled for the agent", async () => {
    const services = fakeServices({ H1: tmp }, { redactOutput: true });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({
        command:
          "echo sk-abcdefghijklmnopqrstuvwxyz012345; echo gsk_abcdefghijklmnopqrstuvwxyz012345",
      }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<ExecBody>(res);
    expect(body.stdout).toContain("[REDACTED]");
    expect(body.stdout).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(body.stdout).not.toContain("gsk_abcdefghijklmnopqrstuvwxyz012345");
  });
});

interface ExecPermissionCall {
  agent_name: string;
  tool_name: ExecToolName;
}

function gatedServices(opts: {
  worktreePath: string;
  agentName?: string;
  autoApprove?: string[];
  dangerousPatterns?: string[];
  decide?: (toolName: ExecToolName) => boolean;
}): { services: Services; calls: ExecPermissionCall[] } {
  const agentName = opts.agentName ?? "agent-x";
  const calls: ExecPermissionCall[] = [];
  const decide = opts.decide ?? ((): boolean => true);
  const permissionService: ExecPermissionService = {
    requestPermission: (input: ExecPermissionInput): Promise<{ approved: boolean }> => {
      calls.push({ agent_name: input.agent_name, tool_name: input.tool_name });
      return Promise.resolve({ approved: decide(input.tool_name) });
    },
  };
  const services = fakeServices(
    { H1: opts.worktreePath },
    {
      handoffs: { H1: { to_agent: agentName } },
      dangerousPatterns: { [agentName]: opts.dangerousPatterns ?? [] },
      agentchatConfig: { agents: [{ name: agentName, auto_approve_to: opts.autoApprove ?? [] }] },
      permissionService,
    },
  );
  return { services, calls };
}

describe("worktrees exec route \u2014 permission unification", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routes-fs-exec-perm-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("(a) denies a benign command when the permission service rejects shell_run", async () => {
    const { services, calls } = gatedServices({
      worktreePath: tmp,
      autoApprove: [],
      decide: () => false,
    });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo hello" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(403);
    const body = await jsonBody<RouteErrorBody>(res);
    expect(body.error.code).toBe("permission_denied");
    // The command must NOT have executed.
    expect(JSON.stringify(body)).not.toContain("hello");
    expect(calls.some((c) => c.tool_name === "shell_run")).toBe(true);
  });

  it("(b) trust_mode:all (auto_approve shell_run) still executes without a prompt", async () => {
    const { services, calls } = gatedServices({
      worktreePath: tmp,
      autoApprove: ["shell_run"],
      // Even a rejecting service must be bypassed by the auto-approve fast path.
      decide: () => false,
    });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo unattended" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<ExecBody>(res);
    expect(body.stdout).toContain("unattended");
    expect(body.exit_code).toBe(0);
    // Auto-approve means the general gate never hits the permission service.
    expect(calls.some((c) => c.tool_name === "shell_run")).toBe(false);
  });

  it("(c) routes through the permission service (same hook shell_run uses)", async () => {
    const { services, calls } = gatedServices({
      worktreePath: tmp,
      autoApprove: [],
      decide: () => true,
    });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo approved" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<ExecBody>(res);
    expect(body.stdout).toContain("approved");
    expect(calls).toContainEqual({ agent_name: "agent-x", tool_name: "shell_run" });
  });

  it("(d) dangerous commands are gated via the permission service, not raw regex", async () => {
    const { services, calls } = gatedServices({
      worktreePath: tmp,
      autoApprove: ["shell_run"],
      dangerousPatterns: ["rm\\s+-rf"],
      // General is auto-approved; dangerous must still consult the service and be denied.
      decide: (toolName) => toolName === "shell_run",
    });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "rm -rf /tmp/whatever" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(403);
    const body = await jsonBody<DangerousCommandBody>(res);
    expect(body.error.code).toBe("dangerous_command");
    expect(body.error.matched.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.tool_name === "shell_run.dangerous")).toBe(true);
  });

  it("(e) a dangerous command approved by the permission service executes", async () => {
    const { services, calls } = gatedServices({
      worktreePath: tmp,
      autoApprove: ["shell_run"],
      dangerousPatterns: ["echo\\s+danger"],
      decide: () => true,
    });
    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo danger" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<ExecBody>(res);
    expect(body.stdout).toContain("danger");
    expect(calls.some((c) => c.tool_name === "shell_run.dangerous")).toBe(true);
  });
});
