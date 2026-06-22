import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PenumbraClient } from "../src/penumbra-client.js";
import { type GradeResult, gradeResults, type GradeResultsOpts } from "./bench-grade.js";
import { BENCH_SYSTEM_PROMPT, BENCH_TASKS, type BenchTask } from "./bench-prompts.js";

interface BenchStartChainInput {
  initial_agent: string;
  message: string;
  task_type: string;
  use_worktree: boolean;
  trust_mode: "all" | "config";
  caller_cwd: string;
  project_id: string;
}

interface BenchStartChainResult {
  conversation_id: string;
  handoff_id: string;
}

interface BenchHandoffStatus {
  status: string;
  latency_seconds: number | null;
}

interface BenchChainResponse {
  text: string;
}

interface BenchChainResponses {
  responses: BenchChainResponse[];
}

interface BenchTokenBudget {
  tokens_in?: number;
  tokens_out?: number;
}

interface BenchTimelineEvent {
  _meta?: { token_budget?: BenchTokenBudget };
}

interface BenchTimeline {
  events: BenchTimelineEvent[];
}

export interface BenchAcpClient {
  startChain(body: BenchStartChainInput): Promise<BenchStartChainResult>;
  getHandoffStatus(handoff_id: string): Promise<BenchHandoffStatus>;
  getChainResponses(conversation_id: string, which: "final" | "all"): Promise<BenchChainResponses>;
  getDispatchTimeline(handoff_id: string): Promise<BenchTimeline>;
}

export type GradeResultsFn = (opts: GradeResultsOpts) => Promise<GradeResult[]>;

export interface RunBenchAcpOpts {
  agents: string[];
  tasks?: string[];
  judgeUrl?: string;
  judgeModel?: string;
  judgeAuthToken?: string;
  judgeCaPath?: string;
  concurrency?: number;
  outPath?: string;
  configPath?: string;
  projectId?: string;
  client?: BenchAcpClient;
  gradeResultsFn?: GradeResultsFn;
}

interface RawResult {
  agent: string;
  task: BenchTask["id"];
  answer: string;
  latency_s: number;
  tokens: number;
  model: string;
  label: string;
}

interface FinalResult {
  agent: string;
  task: BenchTask["id"];
  verdict: string;
  latency_s: number;
  tokens: number;
  response_excerpt: string;
}

export interface SummaryRow {
  agent: string;
  passRate: number;
  medianLatency: number;
  totalTokens: number;
}

interface SummaryAccumulator {
  agent: string;
  passes: number;
  total: number;
  latencies: number[];
  totalTokens: number;
}

interface QueueItem {
  agent: string;
  task: BenchTask;
}

const REPO_ROOT_FROM_SCRIPTS = "../../..";

function bridgePenumbraClient(client: PenumbraClient): BenchAcpClient {
  return {
    startChain: async (body): Promise<BenchStartChainResult> => await client.startChain(body),
    getHandoffStatus: async (id): Promise<BenchHandoffStatus> => {
      const res = await client.getHandoffStatus(id);
      return { status: res.status, latency_seconds: res.latency_seconds };
    },
    getChainResponses: async (id, which): Promise<BenchChainResponses> => {
      const res = await client.getChainResponses(id, which);
      return { responses: res.responses.map((r) => ({ text: r.text })) };
    },
    getDispatchTimeline: async (id): Promise<BenchTimeline> => {
      const res = await client.getDispatchTimeline(id);
      const events: BenchTimelineEvent[] = [];
      for (const ev of res.events) {
        if (ev !== null && typeof ev === "object" && "_meta" in ev) {
          events.push(ev as BenchTimelineEvent);
        } else {
          events.push({});
        }
      }
      return { events };
    },
  };
}

function sumTokensFromTimeline(timeline: BenchTimeline): number {
  let total = 0;
  for (const ev of timeline.events) {
    const budget = ev._meta?.token_budget;
    if (budget) {
      total += (budget.tokens_in ?? 0) + (budget.tokens_out ?? 0);
    }
  }
  return total;
}

async function processItem(
  client: BenchAcpClient,
  item: QueueItem,
  projectId: string,
): Promise<RawResult> {
  const fixturePath = join(import.meta.dirname, item.task.fixturePath);
  const fixtureBody = readFileSync(fixturePath, "utf8");
  const prompt = `--- File: ${item.task.fixtureLabel} ---\n${fixtureBody}\n\n---\n\n${item.task.question}`;
  const message = BENCH_SYSTEM_PROMPT + "\n\n" + prompt;

  const start = await client.startChain({
    initial_agent: item.agent,
    message,
    task_type: "unknown",
    use_worktree: false,
    trust_mode: "all",
    caller_cwd: join(import.meta.dirname, REPO_ROOT_FROM_SCRIPTS),
    project_id: projectId,
  });

  let status: BenchHandoffStatus;
  for (;;) {
    status = await client.getHandoffStatus(start.handoff_id);
    if (["completed", "failed", "cancelled", "rejected"].includes(status.status)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const responses = await client.getChainResponses(start.conversation_id, "final");
  const finalAnswer =
    responses.responses.length > 0 ? (responses.responses.at(-1)?.text ?? "") : "";

  let totalTokens = 0;
  try {
    const timeline = await client.getDispatchTimeline(start.handoff_id);
    totalTokens = sumTokensFromTimeline(timeline);
  } catch {
    // best-effort token accounting
  }

  return {
    agent: item.agent,
    task: item.task.id,
    answer: finalAnswer,
    latency_s: status.latency_seconds ?? 0,
    tokens: totalTokens,
    model: item.agent,
    label: item.task.fixtureLabel,
  };
}

async function runWorkers(
  client: BenchAcpClient,
  queue: QueueItem[],
  concurrency: number,
  projectId: string,
): Promise<RawResult[]> {
  const rawResults: RawResult[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < queue.length) {
      const item = queue[index++];
      if (item === undefined) {
        continue;
      }
      try {
        const res = await processItem(client, item, projectId);
        rawResults.push(res);
      } catch (err: unknown) {
        console.error(`Error processing agent=${item.agent} task=${item.task.id}`, err);
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return rawResults;
}

function buildFinalResults(rawResults: RawResult[], graded: GradeResult[]): FinalResult[] {
  return rawResults.map((r) => {
    const match = graded.find((g) => g.task === r.task && g.model === r.model);
    return {
      agent: r.agent,
      task: r.task,
      verdict: match ? match.verdict : "ERROR",
      latency_s: r.latency_s,
      tokens: r.tokens,
      response_excerpt: r.answer.slice(0, 100).replaceAll("\n", " "),
    };
  });
}

function medianOf(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function accumulateRow(map: Map<string, SummaryAccumulator>, r: FinalResult): void {
  let acc = map.get(r.agent);
  if (!acc) {
    acc = { agent: r.agent, passes: 0, total: 0, latencies: [], totalTokens: 0 };
    map.set(r.agent, acc);
  }
  acc.total++;
  if (r.verdict === "PASS") {
    acc.passes++;
  }
  acc.latencies.push(r.latency_s);
  acc.totalTokens += r.tokens;
}

function computeSummary(finalResults: FinalResult[]): SummaryRow[] {
  const summaryMap = new Map<string, SummaryAccumulator>();
  for (const r of finalResults) {
    accumulateRow(summaryMap, r);
  }

  const summary: SummaryRow[] = [];
  for (const s of summaryMap.values()) {
    summary.push({
      agent: s.agent,
      passRate: s.total === 0 ? 0 : s.passes / s.total,
      medianLatency: medianOf(s.latencies),
      totalTokens: s.totalTokens,
    });
  }

  summary.sort((a, b) => b.passRate - a.passRate || a.medianLatency - b.medianLatency);
  return summary;
}

export async function runBenchAcp(
  opts: RunBenchAcpOpts,
): Promise<{ jsonl: string; summary: SummaryRow[]; rows: FinalResult[] }> {
  const tasks = opts.tasks ? BENCH_TASKS.filter((t) => opts.tasks?.includes(t.id)) : BENCH_TASKS;
  const concurrency = opts.concurrency ?? 2;
  const client: BenchAcpClient = opts.client ?? bridgePenumbraClient(new PenumbraClient());
  const gradeFn: GradeResultsFn = opts.gradeResultsFn ?? gradeResults;
  const projectId = opts.projectId ?? "penumbra";

  const queue: QueueItem[] = [];
  for (const agent of opts.agents) {
    for (const task of tasks) {
      queue.push({ agent, task });
    }
  }

  const rawResults = await runWorkers(client, queue, concurrency, projectId);

  const gradingInput = rawResults.map((r) => ({
    task: r.task,
    answer: r.answer,
    model: r.model,
    label: r.label,
  }));

  const graded = await gradeFn({
    results: gradingInput,
    url: opts.judgeUrl ?? "https://api.openai.com/v1",
    model: opts.judgeModel ?? "gpt-4o",
    authToken: opts.judgeAuthToken,
    caPath: opts.judgeCaPath,
  });

  const finalResults = buildFinalResults(rawResults, graded);

  let jsonl = "";
  for (const r of finalResults) {
    jsonl += JSON.stringify(r) + "\n";
  }

  if (opts.outPath) {
    writeFileSync(opts.outPath, jsonl);
  }

  const summary = computeSummary(finalResults);
  return { jsonl, summary, rows: finalResults };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < argv.length) {
      return argv[i + 1];
    }
    return undefined;
  };

  const parseCsv = (val: string | undefined): string[] | undefined =>
    val ? val.split(",").map((s) => s.trim()) : undefined;

  const agents = parseCsv(flag("agents"));
  if (!agents || agents.length === 0) {
    console.error(
      "usage: bun bench-acp.ts --agents <agent1,agent2> [--tasks T4,T5] [--judge-url <url>] [--judge-model <model>] [--out <file>] [--concurrency 2]",
    );
    process.exit(1);
  }

  const tasks = parseCsv(flag("tasks"));
  const judgeUrl = flag("judge-url");
  const judgeModel = flag("judge-model");
  const outPath = flag("out");
  const configPath = flag("config-path");
  const projectId = flag("project-id") ?? "penumbra";
  const concurrency = parseInt(flag("concurrency") ?? "2", 10);

  runBenchAcp({
    agents,
    tasks,
    judgeUrl,
    judgeModel,
    outPath,
    configPath,
    projectId,
    concurrency,
  })
    .then((result) => {
      process.stdout.write("JSONL Output:\n");
      process.stdout.write(result.jsonl);
      process.stdout.write("\nSummary:\n");
      process.stdout.write(JSON.stringify(result.summary, null, 2) + "\n");
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
