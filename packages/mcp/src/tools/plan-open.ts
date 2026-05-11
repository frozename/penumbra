import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

const PlanOpenInputSchema = z.object({
  goal: z.string().min(1),
  steps: z.array(z.string().min(1)).optional(),
}).strict();

export const PlanOpenInputShape = PlanOpenInputSchema.shape;

const DEFAULT_HOME_PROJECT = 'penumbra';
const DEFAULT_PREFERRED_AGENT = 'codex-acp-fast';
const DEFAULT_FALLBACK_AGENT = 'claude-acp-sonnet';

type PlanOpenDaemon = Pick<DaemonClient, 'planStart'> & Partial<Pick<DaemonClient, 'listChainAgents'>>;

export function planOpenHandler(daemon: PlanOpenDaemon) {
  return async (input: unknown) => {
    const parsed = PlanOpenInputSchema.parse(input ?? {});
    const [preferredAgent, fallbackAgent] = await resolveDefaultAgents(daemon);
    const filePath = await writePlanOpenFile({
      goal: parsed.goal,
      steps: parsed.steps ?? [],
      preferredAgent,
      fallbackAgent,
    });
    return daemon.planStart({ file_path: filePath });
  };
}

async function resolveDefaultAgents(daemon: PlanOpenDaemon): Promise<[string, string]> {
  if (!daemon.listChainAgents) {
    return [DEFAULT_PREFERRED_AGENT, DEFAULT_FALLBACK_AGENT];
  }
  try {
    const listed = await daemon.listChainAgents();
    const names = listed.agents.map((agent) => agent.name).filter((name) => name.length > 0);
    if (names.length === 0) {
      return [DEFAULT_PREFERRED_AGENT, DEFAULT_FALLBACK_AGENT];
    }
    if (names.length === 1) {
      return [names[0]!, names[0]!];
    }
    return [names[0]!, names[1]!];
  } catch {
    return [DEFAULT_PREFERRED_AGENT, DEFAULT_FALLBACK_AGENT];
  }
}

async function writePlanOpenFile(input: {
  goal: string;
  steps: string[];
  preferredAgent: string;
  fallbackAgent: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'penumbra-plan-open-'));
  const filePath = join(root, 'plan-open.md');
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
  await writeFile(filePath, body, 'utf8');
  return filePath;
}

function renderPlanOpenMarkdown(input: {
  goal: string;
  steps: string[];
  preferredAgent: string;
  fallbackAgent: string;
  taskPath: string;
  timestamp: string;
}): string {
  const stepsBlock = input.steps.length > 0
    ? input.steps.map((step, idx) => `${idx + 1}. ${step}`).join('\n')
    : '1. Clarify and break down the goal into actionable implementation steps.';
  return [
    '---',
    'plan_id: plan_open',
    `home_project: ${DEFAULT_HOME_PROJECT}`,
    '---',
    '',
    '# Plan Open',
    '',
    `Opened at: ${input.timestamp}`,
    '',
    '```yaml meta',
    'id: "1.1"',
    `files: [${input.taskPath}]`,
    'file_scope: new',
    'depends_on: []',
    'parallel_with: []',
    `preferred_agent: ${input.preferredAgent}`,
    `fallback_agent: ${input.fallbackAgent}`,
    'task_size: small',
    'risk_class: paste-ready',
    '```',
    '',
    `Goal: ${input.goal}`,
    '',
    'Initial steps:',
    stepsBlock,
    '',
  ].join('\n');
}
