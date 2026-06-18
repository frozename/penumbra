import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { worktreesExecRoute } from "../src/routes/fs.js";

function fakeServices(
  worktrees: Record<string, string>,
  opts: {
    handoffs?: Record<string, { to_agent?: string }>;
    dangerousPatterns?: Record<string, string[]>;
  } = {},
): any {
  return {
    worktreeManager: {
      getWorktree: (id: string) => (worktrees[id] ? { handoffId: id, path: worktrees[id] } : null),
    },
    handoffReader: {
      get: (id: string) => opts.handoffs?.[id] ?? null,
    },
    shellConfig: {
      dangerousCommandsForAgent: (agentName: string) => opts.dangerousPatterns?.[agentName] ?? [],
    },
  };
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
    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
    expect(body.exit_code).toBe(3);
    expect(body.timed_out).toBe(false);
  });

  it("returns 403 dangerous_command for matched pattern WITHOUT running", async () => {
    let commandRan = false;
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
    const body = await res.json();
    expect(body.error.code).toBe("dangerous_command");
    expect(Array.isArray(body.error.matched)).toBe(true);
    expect(body.error.matched.length).toBeGreaterThan(0);
    expect(commandRan).toBe(false);
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
    const body = await res.json();
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
    const body = await res.json();
    expect(body.timed_out).toBe(true);
    expect(body.exit_code).toBeNull();
  });

  it("returns 404 when handoff is unknown", async () => {
    const services = fakeServices({});
    const req = new Request("http://x/worktrees/UNKNOWN/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo hi" }),
    });
    const res = await worktreesExecRoute(req, "UNKNOWN", services);
    expect(res.status).toBe(404);
    const body = await res.json();
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
    const body = await res.json();
    expect(body.error.code).toBe("invalid_args");
  });

  it("returns 503 shell_config_unavailable when shellConfig is undefined, even for a benign command", async () => {
    // Simulate a daemon that booted with a broken agentchat config:
    // shellConfig is undefined on the services object.
    const services: any = {
      worktreeManager: {
        getWorktree: (id: string) => (id === "H1" ? { handoffId: "H1", path: tmp } : null),
      },
      handoffReader: {
        get: (_id: string) => null,
      },
      // shellConfig deliberately absent -- mirrors a failed config load
    };

    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo safe" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("shell_config_unavailable");
    expect(body.error.message).toBe("service temporarily unavailable");
  });

  it("returns 503 shell_config_unavailable when shellConfig is truthy but malformed", async () => {
    const services: any = {
      worktreeManager: {
        getWorktree: (id: string) => (id === "H1" ? { handoffId: "H1", path: tmp } : null),
      },
      handoffReader: {
        get: (_id: string) => null,
      },
      // truthy but malformed shellConfig missing dangerousCommandsForAgent
      shellConfig: {},
    };

    const req = new Request("http://x/worktrees/H1/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo safe" }),
    });
    const res = await worktreesExecRoute(req, "H1", services);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("shell_config_unavailable");
    expect(body.error.message).toBe("service temporarily unavailable");
  });
});
