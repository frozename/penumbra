import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  fixtureSchema,
  runJudgeBench,
  summarizeBench,
} from "../../../../scripts/system-one-judge-bench.js";

const { values } = parseArgs({
  options: {
    config: { type: "string" }, fixtures: { type: "string" }, out: { type: "string" },
    "connection-close": { type: "boolean", default: false },
  },
});
if (!values.config || !values.fixtures || !values.out) throw new Error("config, fixtures, out required");
const config = JSON.parse(readFileSync(values.config, "utf8"));
const fixtures = readFileSync(values.fixtures, "utf8").trim().split("\n")
  .map((line) => fixtureSchema.parse(JSON.parse(line)));
const diagnostics: Record<string, unknown>[] = [];
const connectionClose = values["connection-close"];
const output = await runJudgeBench(config, fixtures, {
  live: true, concurrency: 1, repeats: 1,
  fetch: async (url, init) => {
    const requestSha256 = createHash("sha256").update(init.body).digest("hex");
    const diagnostic: Record<string, unknown> = { requestSha256, at: Date.now(), connectionClose };
    try {
      const response = await globalThis.fetch(url, {
        ...init, headers: { ...init.headers, ...(connectionClose ? { Connection: "close" } : {}) },
      });
      diagnostic.status = response.status;
      diagnostic.responseConnection = response.headers.get("connection");
      diagnostics.push(diagnostic);
      return response;
    } catch (error) {
      const e = error as { name?: string; code?: string; cause?: { code?: string } };
      diagnostics.push({ ...diagnostic, errorName: e.name ?? null, errorCode: e.code ?? null, causeCode: e.cause?.code ?? null });
      throw error;
    }
  },
});
mkdirSync(values.out, { recursive: true });
const transport = { connectionClose, retries: 0, diagnostics: "hashes/status/error codes only" };
writeFileSync(join(values.out, "run.json"), JSON.stringify({ ...output, transport }, null, 2) + "\n");
writeFileSync(join(values.out, "requests.jsonl"), output.rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(join(values.out, "transport.json"), JSON.stringify(diagnostics, null, 2) + "\n");
const summary = summarizeBench(output, fixtures);
writeFileSync(join(values.out, "summary.json"), JSON.stringify({ ...summary, transport }, null, 2) + "\n");
console.log(JSON.stringify({ requests: summary.requests, answered: summary.answered, failures: summary.failures }));
