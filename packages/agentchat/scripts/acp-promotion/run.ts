import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import { PenumbraClient } from '../../src/penumbra-client.js';
import { evaluatePromotionEvidence } from './evaluate.js';
import { renderPromotionJsonl, renderPromotionMarkdown } from './report.js';
import { PROMOTION_SCENARIOS, validatePromotionScenarios } from './scenarios.js';
import type { AcpPromotionRunResult, AcpPromotionScenario, AcpPromotionScenarioId } from './types.js';

const DISPATCH_EVENT_FLUSH_GRACE_MS = 5_000;

export interface PromotionClient {
  startChain(body: {
    initial_agent: string;
    message: string;
    max_hops: number;
    trust_mode: 'all';
    use_worktree: boolean;
    task_type: string;
  }): Promise<{ handoff_id: string; conversation_id: string }>;
  getHandoffStatus(handoff_id: string): Promise<{
    handoff_id: string;
    status: string;
    error_summary: string | null;
    worker_id: string | null;
    started_at: string | null;
    resolved_at: string | null;
    latency_seconds: number | null;
    reliability: {
      status: string;
      trustworthy: boolean;
      recommended_action: string;
      summary: string;
    };
  }>;
  getChainResponses(
    conversation_id: string,
    which: 'final' | 'all',
  ): Promise<{ responses: { text: string; agent: string; ts: string }[] }>;
  getDispatchTimeline(handoff_id: string): Promise<{ events: unknown[] }>;
  dispatchAudit(handoff_id: string): Promise<{ report: any }>;
  inspectWorktree(
    handoff_id: string,
  ): Promise<{ worktree: any; diff_against_main: string; branch_log: string }>;
  grepInWorktree?(
    handoff_id: string,
    args: { pattern: string; path?: string; output_mode?: 'content' | 'files_with_matches'; max_results?: number },
  ): Promise<{ results: any[]; truncated: boolean }>;
}

export interface RunAcpPromotionOptions {
  configPath?: string;
  live: boolean;
  agents: string[];
  baselines: string[];
  scenarios: AcpPromotionScenarioId[];
  outDir?: string;
  storageRoot?: string;
  pollIntervalMs?: number;
  client?: PromotionClient;
  now?: () => string;
}

export async function runAcpPromotion(
  opts: RunAcpPromotionOptions,
): Promise<{ rows: AcpPromotionRunResult[]; jsonl: string; markdown: string }> {
  validatePromotionScenarios(PROMOTION_SCENARIOS);
  const now = opts.now ?? (() => new Date().toISOString());
  const configPath =
    opts.configPath ?? process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
  const config = loadConfig(configPath);
  const scenarioSet = new Set(opts.scenarios);
  const scenarios = PROMOTION_SCENARIOS.filter((scenario) => scenarioSet.has(scenario.id));
  const requestedAgents = [...opts.agents, ...opts.baselines];
  const rows: AcpPromotionRunResult[] = [];
  const client = opts.client ?? new PenumbraClient({ storageRoot: opts.storageRoot });

  for (const agentName of requestedAgents) {
    const agent = config.agents.find((entry) => entry.name === agentName);
    if (!agent) {
      for (const scenario of scenarios) {
        rows.push(blockedRow(now(), agentName, 'unknown', scenario.id, `agent not found in ${configPath}`));
      }
      continue;
    }

    for (const scenario of scenarios) {
      if (!opts.live) {
        rows.push({ ...blockedRow(now(), agent.name, agent.adapter, scenario.id, 'dry-run'), status: 'skipped' });
        continue;
      }

      const started = await client.startChain({
        initial_agent: agent.name,
        message: scenario.prompt,
        max_hops: 1,
        trust_mode: 'all',
        use_worktree: true,
        task_type: 'smoke_test',
      });
      const status = await waitForTerminalStatus(
        client,
        started.handoff_id,
        scenario.timeoutMs,
        opts.pollIntervalMs ?? 5_000,
      );
      const [responses, timeline, audit, worktree] = await Promise.all([
        client.getChainResponses(started.conversation_id, 'all'),
        client.getDispatchTimeline(started.handoff_id),
        client.dispatchAudit(started.handoff_id).catch(() => null),
        client.inspectWorktree(started.handoff_id).catch(() => null),
      ]);
      const artifact = await verifyArtifact(client, started.handoff_id, scenario);

      rows.push(
        evaluatePromotionEvidence({
          agent: agent.name,
          adapter: agent.adapter,
          scenario,
          handoff_id: started.handoff_id,
          conversation_id: started.conversation_id,
          status,
          responses: responses.responses,
          audit,
          timeline,
          worktree,
          artifact,
          now: now(),
        }),
      );
    }
  }

  const jsonl = renderPromotionJsonl(rows);
  const markdown = renderPromotionMarkdown(rows, { generatedAt: now() });
  if (opts.outDir) {
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(join(opts.outDir, 'acp-promotion.jsonl'), jsonl);
    writeFileSync(join(opts.outDir, 'acp-promotion.md'), markdown);
  }
  return { rows, jsonl, markdown };
}

async function verifyArtifact(
  client: PromotionClient,
  handoffId: string,
  scenario: AcpPromotionScenario,
): Promise<{ path: string; expected: string; actual: string | null } | null> {
  if (!scenario.expectedArtifact) return null;
  if (!client.grepInWorktree) {
    return { path: scenario.expectedArtifact.path, expected: scenario.expectedArtifact.content, actual: null };
  }
  const grep = await client.grepInWorktree(handoffId, {
      path: scenario.expectedArtifact.path,
      pattern: scenario.expectedArtifact.content,
      output_mode: 'content',
      max_results: 1,
    })
    .catch(() => null);
  if (!grep) {
    return { path: scenario.expectedArtifact.path, expected: scenario.expectedArtifact.content, actual: null };
  }
  const first = Array.isArray(grep.results) ? (grep.results[0] as any) : null;
  return {
    path: scenario.expectedArtifact.path,
    expected: scenario.expectedArtifact.content,
    actual: typeof first?.text === 'string' ? first.text : null,
  };
}

async function waitForTerminalStatus(
  client: PromotionClient,
  handoffId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<Awaited<ReturnType<PromotionClient['getHandoffStatus']>>> {
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<PromotionClient['getHandoffStatus']>> | null = null;
  while (Date.now() <= deadline) {
    last = await client.getHandoffStatus(handoffId);
    if (!['pending', 'approved', 'redirected', 'dispatched'].includes(last.status)) {
      if (last.reliability.status !== 'missing_dispatch_end') return last;
      return await waitForDispatchEndFlush(client, handoffId, last, pollIntervalMs);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return last;
}

async function waitForDispatchEndFlush(
  client: PromotionClient,
  handoffId: string,
  initial: Awaited<ReturnType<PromotionClient['getHandoffStatus']>>,
  pollIntervalMs: number,
): Promise<Awaited<ReturnType<PromotionClient['getHandoffStatus']>>> {
  const deadline = Date.now() + DISPATCH_EVENT_FLUSH_GRACE_MS;
  let last = initial;
  while (Date.now() <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    last = await client.getHandoffStatus(handoffId);
    if (last.reliability.status !== 'missing_dispatch_end') return last;
  }
  return last;
}

function blockedRow(
  ts: string,
  agent: string,
  adapter: string,
  scenario: AcpPromotionScenarioId,
  reason: string,
): AcpPromotionRunResult {
  return {
    ts,
    agent,
    adapter,
    scenario,
    status: 'blocked',
    handoff_id: null,
    conversation_id: null,
    latency_seconds: null,
    reliability_status: null,
    trustworthy: null,
    recommended_action: null,
    final_response: null,
    expected_artifact: null,
    artifact_verified: null,
    failure_reason: reason,
  };
}

function parseCsv(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const out = await runAcpPromotion({
    live: argv.includes('--live'),
    agents: parseCsv(flag('--agents'), ['gemini-acp-pro', 'codex-acp']),
    baselines: parseCsv(flag('--baselines'), []),
    scenarios: parseCsv(flag('--scenarios'), ['ping_exact']) as AcpPromotionScenarioId[],
    outDir: flag('--out'),
    configPath: flag('--config'),
  });
  console.log(out.markdown);
}
