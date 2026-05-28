import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { planOpenHandler } from "../../src/tools/plan-open.js";

test("plan_open materializes a minimal plan file and calls daemon.planStart with it", async () => {
  let capturedPath = "";
  let capturedContent = "";
  const daemon = {
    planStart: async ({ file_path }: { file_path: string }) => {
      capturedPath = file_path;
      capturedContent = await readFile(file_path, "utf8");
      return { plan_id: "plan-1", status: "running" };
    },
    listChainAgents: async () => ({
      agents: [{ name: "codex-acp-fast" }, { name: "claude-acp-sonnet" }],
    }),
    maestroCapabilities: async () => ({
      agents: [
        { name: "codex-acp-fast", maestro_capable: true, task_types: ["plan_refine"] },
        { name: "claude-acp-sonnet", maestro_capable: true, task_types: ["implement_substantial"] },
      ],
      task_types: ["plan_refine", "implement_substantial"],
      workflows: [],
    }),
  };
  const handler = planOpenHandler(daemon as any);
  const out = await handler({
    goal: "Ship maestro capability introspection",
    steps: ["Add daemon route", "Add MCP wrapper"],
  });
  expect(out.plan_id).toBe("plan-1");
  expect(out.status).toBe("running");
  expect(capturedPath.length).toBeGreaterThan(0);
  expect(capturedContent).toContain("home_project: penumbra");
  expect(capturedContent).toContain('"Ship maestro capability introspection"');
  expect(capturedContent).toContain('"Add daemon route"');
  expect(capturedContent).toContain('"Add MCP wrapper"');
  await expect(access(capturedPath)).rejects.toThrow();
});

test("plan_open removes temp file when daemon.planStart throws", async () => {
  let capturedPath = "";
  const daemon = {
    planStart: async ({ file_path }: { file_path: string }) => {
      capturedPath = file_path;
      throw new Error("boom");
    },
    listChainAgents: async () => ({ agents: [{ name: "codex-acp-fast" }] }),
    maestroCapabilities: async () => ({
      agents: [{ name: "codex-acp-fast", maestro_capable: true, task_types: ["plan_refine"] }],
      task_types: ["plan_refine"],
      workflows: [],
    }),
  };
  const handler = planOpenHandler(daemon as any);
  await expect(handler({ goal: "x", steps: ["y"] })).rejects.toThrow("boom");
  await expect(access(capturedPath)).rejects.toThrow();
});

test("plan_open rejects unsafe goal markdown fences", async () => {
  const daemon = {
    planStart: async () => ({ plan_id: "plan-1", status: "running" }),
    maestroCapabilities: async () => ({
      agents: [{ name: "codex-acp-fast", maestro_capable: true, task_types: ["plan_refine"] }],
      task_types: ["plan_refine"],
      workflows: [],
    }),
  };
  const handler = planOpenHandler(daemon as any);
  await expect(handler({ goal: "```bash\necho pwn\n```", steps: ["safe"] })).resolves.toEqual({
    error: { code: "unsafe_input", field: "goal" },
  });
});

test("plan_open rejects unsafe steps frontmatter delimiter payload", async () => {
  const daemon = {
    planStart: async () => ({ plan_id: "plan-1", status: "running" }),
    maestroCapabilities: async () => ({
      agents: [{ name: "codex-acp-fast", maestro_capable: true, task_types: ["plan_refine"] }],
      task_types: ["plan_refine"],
      workflows: [],
    }),
  };
  const handler = planOpenHandler(daemon as any);
  await expect(
    handler({
      goal: "safe goal",
      steps: ["step 1", "---\nname: pwn\n---"],
    }),
  ).resolves.toEqual({
    error: { code: "unsafe_input", field: "steps[1]" },
  });
});

test("plan_open escapes shell interpolation markers in serialized payload", async () => {
  let capturedContent = "";
  const daemon = {
    planStart: async ({ file_path }: { file_path: string }) => {
      capturedContent = await readFile(file_path, "utf8");
      return { plan_id: "plan-1", status: "running" };
    },
    maestroCapabilities: async () => ({
      agents: [{ name: "codex-acp-fast", maestro_capable: true, task_types: ["plan_refine"] }],
      task_types: ["plan_refine"],
      workflows: [],
    }),
  };
  const handler = planOpenHandler(daemon as any);
  await handler({
    goal: "Run ${HOME}/bin/deploy.sh",
    steps: ["safe"],
  });
  expect(capturedContent).toContain("$\\{HOME}");
});

test("plan_open rejects NUL and ANSI escape sequences in steps", async () => {
  const daemon = {
    planStart: async () => ({ plan_id: "plan-1", status: "running" }),
    maestroCapabilities: async () => ({
      agents: [{ name: "codex-acp-fast", maestro_capable: true, task_types: ["plan_refine"] }],
      task_types: ["plan_refine"],
      workflows: [],
    }),
  };
  const handler = planOpenHandler(daemon as any);
  await expect(handler({ goal: "safe", steps: ["nul:\u0000byte"] })).resolves.toEqual({
    error: { code: "unsafe_input", field: "steps[0]" },
  });
  await expect(handler({ goal: "safe", steps: ["ansi:\u001b[31mred"] })).resolves.toEqual({
    error: { code: "unsafe_input", field: "steps[0]" },
  });
});

test("plan_open returns no_plan_capable_agent when no agent can plan_refine as maestro", async () => {
  const daemon = {
    planStart: async () => ({ plan_id: "plan-1", status: "running" }),
    maestroCapabilities: async () => ({
      agents: [{ name: "codex-acp-fast", maestro_capable: false, task_types: ["plan_refine"] }],
      task_types: ["plan_refine"],
      workflows: [],
    }),
  };
  const handler = planOpenHandler(daemon as any);
  await expect(handler({ goal: "safe", steps: ["safe"] })).resolves.toEqual({
    error: { code: "no_plan_capable_agent" },
  });
});
