import { afterEach, describe, expect, it, spyOn } from "bun:test";

import {
  matchedDangerousPatterns,
  requestCommandPermission,
  type ShellConfig,
} from "@src/routes/command-policy.js";
import type { DaemonServices } from "@src/serve.js";
import type {
  InProcessPermissionDecision,
  InProcessPermissionRequestInput,
} from "@src/services/in-process-permission-service.js";

type RecordingPermissionService = {
  calls: InProcessPermissionRequestInput[];
  requestPermission(input: InProcessPermissionRequestInput): Promise<InProcessPermissionDecision>;
};

function noopWarn(): undefined {
  return undefined;
}

function fakeServices(opts: {
  agentchatConfig?: unknown;
  permissionService?: RecordingPermissionService;
}): DaemonServices {
  return {
    agentchatConfig: opts.agentchatConfig,
    permissionService: opts.permissionService,
  } as unknown as DaemonServices;
}

function recordingPermissionService(approved: boolean): RecordingPermissionService {
  const calls: InProcessPermissionRequestInput[] = [];
  return {
    calls,
    requestPermission(
      input: InProcessPermissionRequestInput,
    ): Promise<InProcessPermissionDecision> {
      calls.push(input);
      return Promise.resolve({ approved, reason: null });
    },
  };
}

function fakeShellConfig(
  perAgentPatterns: Record<string, string[]> = {},
): ShellConfig & { askedFor: string[] } {
  const askedFor: string[] = [];
  return {
    enabled: true,
    maxSessionsPerHandoff: 4,
    maxConcurrentRunsPerSession: 1,
    maxSessionIdleMs: 600000,
    maxCommandDurationMs: 60000,
    outputByteLimit: 1048576,
    redactOutput: true,
    unsetEnv: [],
    dangerousCommands: [],
    askedFor,
    dangerousCommandsForAgent(agentName: string): string[] {
      askedFor.push(agentName);
      return perAgentPatterns[agentName] ?? [];
    },
    redactOutputForAgent(): boolean {
      return true;
    },
  };
}

const spyOns: { mockRestore(): void }[] = [];

afterEach(() => {
  for (const spy of spyOns) spy.mockRestore();
  spyOns.length = 0;
});

describe("requestCommandPermission", () => {
  it("auto-approves shell_run for an agent whose auto_approve_to includes shell_run without consulting the service", async () => {
    const service = recordingPermissionService(false);
    const services = fakeServices({
      agentchatConfig: { agents: [{ name: "agent-a", auto_approve_to: ["shell_run"] }] },
      permissionService: service,
    });

    const result = await requestCommandPermission(services, {
      handoffId: "h1",
      agentName: "agent-a",
      toolName: "shell_run",
      context: {},
    });

    expect(result).toBe("approve");
    expect(service.calls.length).toBe(0);
  });

  it("consults the service for shell_run.dangerous even when shell_run is auto-approved and returns the service decision", async () => {
    const service = recordingPermissionService(false);
    const services = fakeServices({
      agentchatConfig: { agents: [{ name: "agent-a", auto_approve_to: ["shell_run"] }] },
      permissionService: service,
    });

    const result = await requestCommandPermission(services, {
      handoffId: "h1",
      agentName: "agent-a",
      toolName: "shell_run.dangerous",
      context: {},
    });

    expect(result).toBe("reject");
    expect(service.calls.length).toBe(1);
    expect(service.calls[0]?.tool_name).toBe("shell_run.dangerous");
  });

  it("auto-approves before the missing-service check", async () => {
    const services = fakeServices({
      agentchatConfig: { agents: [{ name: "agent-a", auto_approve_to: ["shell_run"] }] },
    });

    const result = await requestCommandPermission(services, {
      handoffId: "h1",
      agentName: "agent-a",
      toolName: "shell_run",
      context: {},
    });

    expect(result).toBe("approve");
  });

  it("rejects when no permission service is wired and the call is not auto-approved", async () => {
    const services = fakeServices({
      agentchatConfig: { agents: [{ name: "agent-a", auto_approve_to: [] }] },
    });

    const result = await requestCommandPermission(services, {
      handoffId: "h1",
      agentName: "agent-a",
      toolName: "shell_run",
      context: {},
    });

    expect(result).toBe("reject");
  });

  it("does not auto-approve from an auto_approve_to entry belonging to a different agent", async () => {
    const service = recordingPermissionService(false);
    const services = fakeServices({
      agentchatConfig: {
        agents: [
          { name: "agent-a", auto_approve_to: ["shell_run"] },
          { name: "agent-b", auto_approve_to: [] },
        ],
      },
      permissionService: service,
    });

    const result = await requestCommandPermission(services, {
      handoffId: "h1",
      agentName: "agent-b",
      toolName: "shell_run",
      context: {},
    });

    expect(result).toBe("reject");
    expect(service.calls.length).toBe(1);
  });

  it("does not auto-approve when auto_approve_to is a non-array value", async () => {
    const service = recordingPermissionService(false);
    const services = fakeServices({
      agentchatConfig: { agents: [{ name: "agent-a", auto_approve_to: "shell_run" }] },
      permissionService: service,
    });

    const result = await requestCommandPermission(services, {
      handoffId: "h1",
      agentName: "agent-a",
      toolName: "shell_run",
      context: {},
    });

    expect(result).toBe("reject");
    expect(service.calls.length).toBe(1);
  });

  it("does not throw or auto-approve on a malformed agentchatConfig", async () => {
    const service = recordingPermissionService(false);
    const services = fakeServices({
      agentchatConfig: { agents: "not-an-array" },
      permissionService: service,
    });

    const result = await requestCommandPermission(services, {
      handoffId: "h1",
      agentName: "agent-a",
      toolName: "shell_run",
      context: {},
    });

    expect(result).toBe("reject");
    expect(service.calls.length).toBe(1);
  });

  it("forwards the request fields exactly to the permission service", async () => {
    const service = recordingPermissionService(true);
    const services = fakeServices({ permissionService: service });
    const controller = new AbortController();
    const context = { command: "ls" };

    const result = await requestCommandPermission(services, {
      handoffId: "h7",
      agentName: "agent-a",
      toolName: "shell_run",
      context,
      signal: controller.signal,
    });

    expect(result).toBe("approve");
    expect(service.calls.length).toBe(1);
    expect(service.calls[0]).toEqual({
      parent_handoff_id: "h7",
      agent_name: "agent-a",
      tool_name: "shell_run",
      context,
      signal: controller.signal,
    });
    expect(service.calls[0]?.signal).toBe(controller.signal);
    expect(service.calls[0]?.context).toBe(context);
  });

  it("rejects when the service returns approved:false for shell_run", async () => {
    const service = recordingPermissionService(false);
    const services = fakeServices({ permissionService: service });

    const result = await requestCommandPermission(services, {
      handoffId: "h1",
      agentName: "agent-a",
      toolName: "shell_run",
      context: {},
    });

    expect(result).toBe("reject");
  });
});

describe("matchedDangerousPatterns", () => {
  it("collapses runs of whitespace before matching", () => {
    const shellConfig = fakeShellConfig({ "agent-a": ["rm -rf"] });

    expect(matchedDangerousPatterns(shellConfig, "agent-a", "rm\t\t-rf /tmp/x")).toEqual([
      "rm -rf",
    ]);
    expect(matchedDangerousPatterns(shellConfig, "agent-a", "rm \n  -rf x")).toEqual(["rm -rf"]);
  });

  it("returns only the matching patterns in configured order", () => {
    const shellConfig = fakeShellConfig({
      "agent-a": ["git push --force", "rm -rf", "mkfs\\."],
    });

    const matches = matchedDangerousPatterns(
      shellConfig,
      "agent-a",
      "rm -rf /tmp && mkfs.ext4 /dev/sda",
    );

    expect(matches).toEqual(["rm -rf", "mkfs\\."]);
  });

  it("fails closed on a malformed pattern and warns once", () => {
    const warn = spyOn(console, "warn").mockImplementation(noopWarn);
    spyOns.push(warn);
    try {
      const shellConfig = fakeShellConfig({ "agent-a": ["["] });

      expect(matchedDangerousPatterns(shellConfig, "agent-a", "echo hi")).toEqual(["["]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks dangerousCommandsForAgent for the given agent name and uses that agent's list", () => {
    const shellConfig = fakeShellConfig({ "agent-a": ["rm -rf"], "agent-b": [] });

    expect(matchedDangerousPatterns(shellConfig, "agent-a", "rm -rf /")).toEqual(["rm -rf"]);
    expect(matchedDangerousPatterns(shellConfig, "agent-b", "rm -rf /")).toEqual([]);
    expect(shellConfig.askedFor).toEqual(["agent-a", "agent-b"]);
  });

  it("matches case-sensitively since patterns compile with no flags", () => {
    const shellConfig = fakeShellConfig({ "agent-a": ["rm -rf"] });

    expect(matchedDangerousPatterns(shellConfig, "agent-a", "RM -RF /")).toEqual([]);
  });

  it("returns an empty list when the agent has no patterns", () => {
    const shellConfig = fakeShellConfig({ "agent-a": [] });

    expect(matchedDangerousPatterns(shellConfig, "agent-a", "rm -rf /")).toEqual([]);
  });
});
