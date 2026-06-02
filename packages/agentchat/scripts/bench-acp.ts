import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_TASKS, BENCH_SYSTEM_PROMPT } from "./bench-prompts.js";
import { gradeResults } from "./bench-grade.js";
import { PenumbraClient } from "../src/penumbra-client.js";

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
  client?: any;
  gradeResultsFn?: any;
}

export async function runBenchAcp(opts: RunBenchAcpOpts) {
  const agents = opts.agents;
  const tasks = opts.tasks ? BENCH_TASKS.filter(t => opts.tasks!.includes(t.id)) : BENCH_TASKS;
  const concurrency = opts.concurrency || 2;
  const client = opts.client || new PenumbraClient();
  const gradeFn = opts.gradeResultsFn || gradeResults;

  const results: any[] = [];
  let active = 0;
  let queue = [];

  for (const agent of agents) {
    for (const task of tasks) {
      queue.push({ agent, task });
    }
  }

  async function processItem(item: { agent: string, task: typeof BENCH_TASKS[0] }) {
    const fixturePath = join(import.meta.dirname, item.task.fixturePath);
    const fixtureBody = readFileSync(fixturePath, "utf8");
    const prompt = `--- File: ${item.task.fixtureLabel} ---\n${fixtureBody}\n\n---\n\n${item.task.question}`;
    const message = BENCH_SYSTEM_PROMPT + "\n\n" + prompt;

    const start = await client.startChain({
      initial_agent: item.agent,
      message: message,
      task_type: "unknown",
      use_worktree: false,
      trust_mode: "all",
      caller_cwd: join(import.meta.dirname, "../../.."),
    });

    let status;
    while (true) {
      status = await client.getHandoffStatus(start.handoff_id);
      if (["completed", "failed", "cancelled", "rejected"].includes(status.status)) {
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    const responses = await client.getChainResponses(start.conversation_id, "final");
    const finalAnswer = responses.responses && responses.responses.length > 0 
      ? responses.responses[responses.responses.length - 1].text 
      : "";

    let totalTokens = 0;
    try {
      const timeline = await client.getDispatchTimeline(start.handoff_id);
      for (const ev of timeline.events) {
        if (ev._meta && ev._meta.token_budget) {
          totalTokens += (ev._meta.token_budget.tokens_in || 0) + (ev._meta.token_budget.tokens_out || 0);
        }
      }
    } catch (e) {
      // ignore
    }

    const latency = status.latency_seconds || 0;

    return {
      agent: item.agent,
      task: item.task.id,
      answer: finalAnswer,
      latency_s: latency,
      tokens: totalTokens,
      model: item.agent,
      label: item.task.fixtureLabel,
    };
  }

  const rawResults = [];
  const workers = [];
  let index = 0;

  async function worker() {
    while (index < queue.length) {
      const item = queue[index++];
      try {
        const res = await processItem(item);
        rawResults.push(res);
      } catch (err) {
        console.error(`Error processing agent=${item.agent} task=${item.task.id}`, err);
      }
    }
  }

  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Grade results
  const gradingInput = rawResults.map(r => ({
    task: r.task,
    answer: r.answer,
    model: r.model,
    label: r.label,
  }));

  const gradeRes = await gradeFn({
    results: gradingInput,
    url: opts.judgeUrl || "https://api.openai.com/v1",
    model: opts.judgeModel || "gpt-4o",
    authToken: opts.judgeAuthToken,
    caPath: opts.judgeCaPath,
  });

  const finalResults = rawResults.map(r => {
    const graded = gradeRes.find((g: any) => g.task === r.task && g.model === r.model);
    return {
      agent: r.agent,
      task: r.task,
      verdict: graded ? graded.verdict : "ERROR",
      latency_s: r.latency_s,
      tokens: r.tokens,
      response_excerpt: r.answer.slice(0, 100).replace(/\n/g, " "),
    };
  });

  let jsonl = "";
  for (const r of finalResults) {
    jsonl += JSON.stringify(r) + "\n";
  }

  if (opts.outPath) {
    writeFileSync(opts.outPath, jsonl);
  }

  // Summary tabulator
  const summaryMap = new Map();
  for (const r of finalResults) {
    if (!summaryMap.has(r.agent)) {
      summaryMap.set(r.agent, { agent: r.agent, passes: 0, total: 0, latencies: [], totalTokens: 0 });
    }
    const s = summaryMap.get(r.agent);
    s.total++;
    if (r.verdict === "PASS") s.passes++;
    s.latencies.push(r.latency_s);
    s.totalTokens += r.tokens;
  }

  const summary = Array.from(summaryMap.values()).map(s => {
    s.latencies.sort((a: number, b: number) => a - b);
    const mid = Math.floor(s.latencies.length / 2);
    const median = s.latencies.length % 2 !== 0 ? s.latencies[mid] : (s.latencies[mid - 1] + s.latencies[mid]) / 2;
    return {
      agent: s.agent,
      passRate: s.passes / s.total,
      medianLatency: median || 0,
      totalTokens: s.totalTokens,
    };
  });

  summary.sort((a, b) => b.passRate - a.passRate || a.medianLatency - b.medianLatency);

  return { jsonl, summary, rows: finalResults };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    return undefined;
  };
  
  const parseCsv = (val: string | undefined) => val ? val.split(",").map(s => s.trim()) : undefined;

  const agents = parseCsv(flag("agents"));
  if (!agents || agents.length === 0) {
    console.error("usage: bun bench-acp.ts --agents <agent1,agent2> [--tasks T4,T5] [--judge-url <url>] [--judge-model <model>] [--out <file>] [--concurrency 2]");
    process.exit(1);
  }

  const tasks = parseCsv(flag("tasks"));
  const judgeUrl = flag("judge-url");
  const judgeModel = flag("judge-model");
  const outPath = flag("out");
  const configPath = flag("config-path");
  const concurrency = parseInt(flag("concurrency") || "2", 10);

  runBenchAcp({
    agents,
    tasks,
    judgeUrl,
    judgeModel,
    outPath,
    configPath,
    concurrency,
  }).then(result => {
    console.log("JSONL Output:");
    console.log(result.jsonl);
    console.log("\nSummary:");
    console.table(result.summary);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
