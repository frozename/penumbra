import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

const PlanOpenInputSchema = z
  .object({
    goal: z.string().min(1),
    steps: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const PlanOpenInputShape = PlanOpenInputSchema.shape;

const DEFAULT_HOME_PROJECT = "penumbra";
const DEFAULT_PREFERRED_AGENT = "openai-codex-fast-acp";

type PlanOpenDaemon = Pick<DaemonClient, "planStart"> &
  Partial<Pick<DaemonClient, "listChainAgents" | "maestroCapabilities">>;

export function planOpenHandler(daemon: PlanOpenDaemon) {
  return async (input: unknown) => {
    const parsed = PlanOpenInputSchema.parse(input ?? {});
    const unsafeField = findUnsafeField(parsed.goal, parsed.steps ?? []);
    if (unsafeField) {
      return { error: { code: "unsafe_input", field: unsafeField } };
    }

    const resolvedAgents = await resolveDefaultAgents(daemon);
    if ("error" in resolvedAgents) {
      return resolvedAgents;
    }
    const [preferredAgent, fallbackAgent] = resolvedAgents;

    const tmp = await writePlanOpenFile({
      goal: parsed.goal,
      steps: parsed.steps ?? [],
      preferredAgent,
      fallbackAgent,
    });
    try {
      return await daemon.planStart({ file_path: tmp.filePath });
    } finally {
      await rm(tmp.root, { recursive: true, force: true });
    }
  };
}

async function resolveDefaultAgents(
  daemon: PlanOpenDaemon,
): Promise<[string, string] | { error: { code: "no_plan_capable_agent" } }> {
  if (!daemon.maestroCapabilities) {
    return { error: { code: "no_plan_capable_agent" } };
  }

  let fallbackAgent: string | null = null;
  try {
    const capabilities = await daemon.maestroCapabilities();
    fallbackAgent =
      capabilities.agents.find(
        (agent) =>
          agent.maestro_capable === true && (agent.task_types ?? []).includes("plan_refine"),
      )?.name ?? null;
  } catch {
    return { error: { code: "no_plan_capable_agent" } };
  }

  if (!fallbackAgent) {
    return { error: { code: "no_plan_capable_agent" } };
  }

  if (!daemon.listChainAgents) {
    return [DEFAULT_PREFERRED_AGENT, fallbackAgent];
  }

  try {
    const listed = await daemon.listChainAgents();
    const names = listed.agents.map((agent) => agent.name).filter((name) => name.length > 0);
    if (names.length === 0) {
      return [DEFAULT_PREFERRED_AGENT, fallbackAgent];
    }
    return [names[0]!, fallbackAgent];
  } catch {
    return [DEFAULT_PREFERRED_AGENT, fallbackAgent];
  }
}

async function writePlanOpenFile(input: {
  goal: string;
  steps: string[];
  preferredAgent: string;
  fallbackAgent: string;
}): Promise<{ root: string; filePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "penumbra-plan-open-"));
  const filePath = join(root, "plan-open.md");
  const timestamp = new Date().toISOString();
  const taskPath = `docs/plan-open-${Date.now()}.md`;
  const body = renderPlanOpenMarkdown({
    goal: input.goal,
    steps: input.steps,
    preferredAgent: input.preferredAgent,
    fallbackAgent: input.fallbackAgent,
    taskPath,
    timestamp,
  });
  await writeFile(filePath, body, "utf8");
  return { root, filePath };
}

function renderPlanOpenMarkdown(input: {
  goal: string;
  steps: string[];
  preferredAgent: string;
  fallbackAgent: string;
  taskPath: string;
  timestamp: string;
}): string {
  const goalJson = encodeUserValue(input.goal);
  const stepsJson = encodeUserValue(input.steps);
  const stepsBlock =
    input.steps.length > 0
      ? input.steps.map((step, idx) => `${idx + 1}. ${encodeUserValue(step)}`).join("\n")
      : '1. "Clarify and break down the goal into actionable implementation steps."';
  return [
    "---",
    "plan_id: plan_open",
    `home_project: ${DEFAULT_HOME_PROJECT}`,
    "---",
    "",
    "# Plan Open",
    "",
    `Opened at: ${input.timestamp}`,
    "",
    "```yaml meta",
    'id: "1.1"',
    `files: [${input.taskPath}]`,
    "file_scope: new",
    "depends_on: []",
    "parallel_with: []",
    `preferred_agent: ${input.preferredAgent}`,
    `fallback_agent: ${input.fallbackAgent}`,
    `goal_json: ${goalJson}`,
    `steps_json: ${stepsJson}`,
    "task_size: small",
    "risk_class: paste-ready",
    "```",
    "",
    `Goal (JSON): ${goalJson}`,
    "",
    "Initial steps (JSON strings):",
    stepsBlock,
    "",
  ].join("\n");
}

function encodeUserValue(value: unknown): string {
  return JSON.stringify(value).replaceAll("${", "$\\{");
}

function findUnsafeField(goal: string, steps: string[]): string | null {
  if (containsUnsafeInput(goal)) return "goal";
  for (let i = 0; i < steps.length; i += 1) {
    if (containsUnsafeInput(steps[i]!)) return `steps[${i}]`;
  }
  return null;
}

function containsUnsafeInput(value: string): boolean {
  if (value.includes("```")) return true;
  if (/(^|\n)\s*---\s*(\n|$)/m.test(value)) return true;
  if (/(^|\n)\s*!![^\n]*/m.test(value)) return true;
  if (/[\u0000]/.test(value)) return true;
  if (/[\u001B\u009B]\[[0-?]*[ -/]*[@-~]/.test(value)) return true;
  return false;
}
