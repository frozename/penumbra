import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/load.js';
import { resolveAdapterApiKey } from '../src/adapters/secret.js';
import { runBench, type BenchResult } from './bench.js';
import { gradeResults, type GradeResult } from './bench-grade.js';
import { BENCH_TASKS } from './bench-prompts.js';

/**
 * bench-fleet.ts
 *
 * Dispatches bench-2 against all configured HTTP-direct cloud agents,
 * then pipes each agent's results through bench-grade.ts to produce a summary calibration table.
 */

interface FleetBenchOpts {
  include?: RegExp;
  exclude?: RegExp;
  skipGrade?: boolean;
  judgeUrl?: string;
  judgeModel?: string;
  judgeToken?: string;
  judgeCaPath?: string;
  fetch?: typeof fetch;
}

async function runFleetBench(opts: FleetBenchOpts = {}) {
  const configPath = join(homedir(), '.config', 'agentchat', 'agentchat.yaml');
  if (!existsSync(configPath)) {
    throw new Error(`agentchat.yaml not found at ${configPath}`);
  }

  const config = loadConfig(configPath);
  const agents = config.agents.filter(a => {
    if (a.adapter !== 'openai-compat-http') return false;
    if (opts.include && !opts.include.test(a.name)) return false;
    if (opts.exclude && opts.exclude.test(a.name)) return false;
    return true;
  });

  if (agents.length === 0) {
    console.log('No matching openai-compat-http agents found.');
    return;
  }

  const fleetResults: Record<string, { bench: BenchResult[]; grades?: GradeResult[] }> = {};

  for (const agent of agents) {
    const options = agent.options as any;
    const baseUrl = options.baseUrl;
    const model = options.model;

    if (!baseUrl || !model) {
      console.warn(`Skipping agent ${agent.name}: missing baseUrl or model`);
      continue;
    }

    let apiKey = '';
    try {
      apiKey = resolveAdapterApiKey(options, { hostPlatform: process.platform as any });
    } catch (err) {
      console.warn(`Skipping agent ${agent.name}: failed to resolve apiKey: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const isStrict = /groq\.com|generativelanguage\.googleapis\.com|openai\.com/.test(baseUrl);

    console.error(`Benchmarking ${agent.name}...`);
    const benchResults = await runBench({
      label: agent.name,
      url: baseUrl,
      model: model,
      authToken: apiKey,
      extraBody: options.extraBody,
      strictOpenAI: isStrict,
      fetch: opts.fetch,
    });

    fleetResults[agent.name] = { bench: benchResults };

    if (!opts.skipGrade) {
      console.error(`Grading ${agent.name}...`);
      const grades = await gradeResults({
        results: benchResults,
        url: opts.judgeUrl || 'https://192.168.68.76:7843/v1',
        model: opts.judgeModel || 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf',
        authToken: opts.judgeToken,
        caPath: opts.judgeCaPath || '/tmp/llamactl-mac-mini-ca.pem',
        fetch: opts.fetch,
      });
      fleetResults[agent.name].grades = grades;
    }
  }

  printSummaryTable(fleetResults, opts.skipGrade);
}

function printSummaryTable(fleetResults: Record<string, { bench: BenchResult[]; grades?: GradeResult[] }>, skipGrade?: boolean) {
  const taskIds = BENCH_TASKS.map(t => t.id);
  const header = `| Agent | ${taskIds.join(' | ')} | Net | Latency p50 |`;
  const separator = `| :--- | ${taskIds.map(() => ':---:').join(' | ')} | :---: | :---: |`;
  
  console.log(header);
  console.log(separator);

  for (const [name, data] of Object.entries(fleetResults)) {
    const latencies = data.bench.map(r => r.latencyMs).sort((a, b) => a - b);
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
  const skipGrade = argv.includes('--skip-grade');

  const opts: FleetBenchOpts = {
    include: includeStr ? new RegExp(includeStr) : undefined,
    exclude: excludeStr ? new RegExp(excludeStr) : undefined,
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

export { runFleetBench };
