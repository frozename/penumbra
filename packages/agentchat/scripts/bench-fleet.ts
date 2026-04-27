import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/load.js';
import { resolveAdapterApiKey } from '../src/adapters/secret.js';
import { runBench, type BenchResult } from './bench.js';
import { gradeResults, type GradeResult } from './bench-grade.js';
import { BENCH_TASKS } from './bench-prompts.js';
import type { AgentChatConfig } from '../src/config/types.js';

/**
 * bench-fleet.ts
 *
 * Dispatches bench-2 against all configured HTTP-direct cloud agents,
 * then pipes each agent's results through bench-grade.ts to produce a summary calibration table.
 * 
 * Resilience features:
 * - Per-agent timeout (default 180s, --per-agent-timeout-ms)
 * - Skip-on-error: Continues to next agent if one fails.
 * - Skip-by-tag: By default, skips agents with tags 'avoid-on-free-tier' or 'swap-required'.
 *   Override with --include-tags or --exclude-tags.
 */

export interface FleetBenchDeps {
  existsSync: typeof existsSync;
  loadConfig: typeof loadConfig;
  resolveAdapterApiKey: typeof resolveAdapterApiKey;
  runBench: typeof runBench;
  gradeResults: typeof gradeResults;
}

interface FleetBenchOpts {
  include?: RegExp;
  exclude?: RegExp;
  includeTags?: string[];
  excludeTags?: string[];
  perAgentTimeoutMs?: number;
  skipGrade?: boolean;
  judgeUrl?: string;
  judgeModel?: string;
  judgeToken?: string;
  judgeCaPath?: string;
  fetch?: typeof fetch;
  /** Optional: provide config directly (tests / embedding). */
  config?: AgentChatConfig;
  /** Optional: override default config path. */
  configPath?: string;
  /** Optional: dependency injection seam (tests). */
  deps?: Partial<FleetBenchDeps>;
}

const DEFAULT_SKIP_TAGS = ['avoid-on-free-tier', 'swap-required'];

function resolveDefaultJudgeToken(config: AgentChatConfig, deps: FleetBenchDeps): string | undefined {
  const executor = config.agents.find(a => a.name === 'executor');
  if (!executor) return undefined;
  try {
    return deps.resolveAdapterApiKey(executor.options as any, { hostPlatform: process.platform as any });
  } catch {
    return undefined;
  }
}

async function runFleetBench(opts: FleetBenchOpts = {}) {
  const deps: FleetBenchDeps = {
    existsSync,
    loadConfig,
    resolveAdapterApiKey,
    runBench,
    gradeResults,
    ...opts.deps,
  };

  const configPath = opts.configPath ?? join(homedir(), '.config', 'agentchat', 'agentchat.yaml');
  const config = opts.config ?? (() => {
    if (!deps.existsSync(configPath)) {
      throw new Error(`agentchat.yaml not found at ${configPath}`);
    }
    return deps.loadConfig(configPath);
  })();

  const agents = config.agents.filter(a => a.adapter === 'openai-compat-http');

  if (agents.length === 0) {
    console.log('No matching openai-compat-http agents found.');
    return;
  }

  const fleetResults: Record<string, { bench?: BenchResult[]; grades?: GradeResult[]; status?: string; error?: string }> = {};

  for (const agent of agents) {
    const agentTags = agent.tags ?? [];
    let skipReason: string | undefined;

    if (opts.include && !opts.include.test(agent.name)) skipReason = 'filtered by name';
    if (opts.exclude && opts.exclude.test(agent.name)) skipReason = 'filtered by name';

    if (opts.includeTags) {
      if (!agentTags.some(t => opts.includeTags!.includes(t))) {
        skipReason = 'filtered by tags (not included)';
      }
    } else {
      const excludeTags = opts.excludeTags ?? DEFAULT_SKIP_TAGS;
      if (agentTags.some(t => excludeTags.includes(t))) {
        skipReason = 'tag mismatch (excluded)';
      }
    }

    if (skipReason) {
      fleetResults[agent.name] = { status: 'SKIPPED' };
      continue;
    }

    const options = agent.options as any;
    const baseUrl = options.baseUrl;
    const model = options.model;

    if (!baseUrl || !model) {
      console.warn(`Skipping agent ${agent.name}: missing baseUrl or model`);
      fleetResults[agent.name] = { status: 'ERROR', error: 'missing baseUrl or model' };
      continue;
    }

    let apiKey = '';
    try {
      apiKey = deps.resolveAdapterApiKey(options, { hostPlatform: process.platform as any });
    } catch (err) {
      console.warn(`Skipping agent ${agent.name}: failed to resolve apiKey: ${err instanceof Error ? err.message : String(err)}`);
      fleetResults[agent.name] = { status: 'ERROR', error: 'apiKey resolution failed' };
      continue;
    }

    const isStrict = /groq\.com|generativelanguage\.googleapis\.com|openai\.com/.test(baseUrl);
    const timeoutMs = opts.perAgentTimeoutMs ?? 180000;

    console.error(`Benchmarking ${agent.name}...`);
    try {
      const benchResults = await withTimeout(signal => deps.runBench({
        label: agent.name,
        url: baseUrl,
        model: model,
        authToken: apiKey,
        extraBody: options.extraBody,
        strictOpenAI: isStrict,
        fetch: opts.fetch,
        signal,
      }), timeoutMs);

      fleetResults[agent.name] = { bench: benchResults };

      if (!opts.skipGrade) {
        console.error(`Grading ${agent.name}...`);
        const judgeToken = opts.judgeToken ?? resolveDefaultJudgeToken(config, deps);
        const grades = await withTimeout(signal => deps.gradeResults({
          results: benchResults,
          url: opts.judgeUrl || 'https://192.168.68.76:7843/v1',
          model: opts.judgeModel || 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf',
          authToken: judgeToken,
          caPath: opts.judgeCaPath || '/tmp/llamactl-mac-mini-ca.pem',
          fetch: opts.fetch,
          signal,
        }), timeoutMs);
        fleetResults[agent.name].grades = grades;
      }
    } catch (err) {
      if (err instanceof TimeoutError || (err instanceof Error && err.name === 'TimeoutError')) {
        console.error(`Timeout benchmarking ${agent.name}`);
        fleetResults[agent.name] = { status: 'TIMEOUT' };
      } else {
        const isExpectedError = err instanceof Error && (
          err.name === 'AbortError' || 
          err.message.includes('HTTP') || 
          err.message.includes('fetch') || 
          err.message.includes('network') ||
          err.message.includes('auth') ||
          err.message.includes('key')
        );

        if (isExpectedError) {
          console.error(`Error benchmarking ${agent.name}: ${err}`);
          fleetResults[agent.name] = { status: 'ERROR', error: err instanceof Error ? err.message : String(err) };
        } else {
          throw err; // Fail loud for helper bugs (TypeError, ReferenceError, etc.)
        }
      }
    }
  }

  printSummaryTable(fleetResults, opts.skipGrade);
}

class TimeoutError extends Error {
  constructor() {
    super('Timeout');
    this.name = 'TimeoutError';
  }
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new TimeoutError()), ms);
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    controller.abort(); // Cancel underlying work if still running
  }
}

function printSummaryTable(fleetResults: Record<string, { bench?: BenchResult[]; grades?: GradeResult[]; status?: string; error?: string }>, skipGrade?: boolean) {
  const taskIds = BENCH_TASKS.map(t => t.id);
  const header = `| Agent | ${taskIds.join(' | ')} | Net | Latency p50 |`;
  const separator = `| :--- | ${taskIds.map(() => ':---:').join(' | ')} | :---: | :---: |`;
  
  console.log(header);
  console.log(separator);

  for (const [name, data] of Object.entries(fleetResults)) {
    if (data.status) {
      const statusMsg = data.status === 'ERROR' ? `ERROR: ${data.error}` : data.status;
      const fillers = taskIds.map(() => statusMsg).join(' | ');
      console.log(`| ${name} | ${fillers} | ${statusMsg} | ${statusMsg} |`);
      continue;
    }

    const bench = data.bench ?? [];
    const latencies = bench.map(r => r.latencyMs).sort((a, b) => a - b);
    const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : 0;
    
    let net = '';
    const taskVerdicts = taskIds.map(taskId => {
      if (skipGrade) return '-';
      const grade = data.grades?.find(g => g.task === taskId);
      if (!grade) return '?';
      if (grade.verdict === 'PASS') return '✅';
      if (grade.verdict === 'PARTIAL') return '⚠️';
      if (grade.verdict.startsWith('ERROR')) return '❌';
      return '🛑';
    });

    if (!skipGrade) {
      const passCount = data.grades?.filter(g => g.verdict === 'PASS').length ?? 0;
      net = `${passCount}/${taskIds.length}`;
    } else {
      net = 'N/A';
    }

    console.log(`| ${name} | ${taskVerdicts.join(' | ')} | ${net} | ${p50}ms |`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const includeStr = flag('include');
  const excludeStr = flag('exclude');
  const includeTagsStr = flag('include-tags');
  const excludeTagsStr = flag('exclude-tags');
  const perAgentTimeoutStr = flag('per-agent-timeout-ms');
  const skipGrade = argv.includes('--skip-grade');

  let perAgentTimeoutMs: number | undefined;
  if (perAgentTimeoutStr) {
    perAgentTimeoutMs = parseInt(perAgentTimeoutStr, 10);
    if (isNaN(perAgentTimeoutMs) || perAgentTimeoutMs <= 0) {
      console.error('Error: --per-agent-timeout-ms must be a positive integer');
      process.exit(1);
    }
  }

  const opts: FleetBenchOpts = {
    include: includeStr ? new RegExp(includeStr) : undefined,
    exclude: excludeStr ? new RegExp(excludeStr) : undefined,
    includeTags: includeTagsStr ? includeTagsStr.split(',') : undefined,
    excludeTags: excludeTagsStr ? excludeTagsStr.split(',') : undefined,
    perAgentTimeoutMs,
    skipGrade,
    judgeUrl: flag('judge-url'),
    judgeModel: flag('judge-model'),
    judgeToken: flag('judge-token'),
    judgeCaPath: flag('judge-ca'),
  };

  try {
    await runFleetBench(opts);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export { runFleetBench, type FleetBenchOpts };
