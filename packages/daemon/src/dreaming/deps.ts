import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { DispatchEventInput } from "@penumbra/core";
import { createResearchAdapter } from "../research/firecrawl-adapter.js";
import { StubJudgePool } from "./judge-pool.js";
import { createDreamingJudgePoolFromAgentchat } from "./dreaming-judge-pool.js";
import { createBriefSynthesizerFromAgentchat } from "./brief-synthesizer.js";
import { ContentQualityJudge } from "./curator/content-quality-judge.js";
import type { DreamCycleDeps } from "./cycle.js";
import type { DreamConfig } from "./config.js";

export function buildDreamCycleDeps(
  services: {
    projectRegistry?: { get(id: string): any; list(): any[] };
    embedder?: { embed(bodies: string[]): Promise<Float32Array[]> };
    dispatchEventLog?: { record(event: DispatchEventInput): void };
  },
  db: Database,
  dreamConfig: DreamConfig,
): DreamCycleDeps {
  const memoryObserve = async (
    briefMarkdown: string,
    projectId: string,
    cycleId: string,
  ): Promise<{ memory_id: string }> => {
    const memory_id = randomUUID();
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, ?, 'system', 'brief', ?, ?, ?, ?, ?, ?)`,
    ).run(
      memory_id,
      projectId,
      nowIso,
      nowIso,
      `Brief: ${projectId} (${cycleId.slice(0, 8)})`,
      briefMarkdown,
      nowIso,
      nowIso,
    );
    return { memory_id };
  };

  const realJudgePool = createDreamingJudgePoolFromAgentchat();
  const judgePool = realJudgePool ?? new StubJudgePool();

  const briefSynthesizer = createBriefSynthesizerFromAgentchat();

  const contentQualityJudge =
    dreamConfig.contentQualityThreshold > 0
      ? new ContentQualityJudge({ threshold: dreamConfig.contentQualityThreshold })
      : undefined;

  const deps: DreamCycleDeps = {
    projectRegistry: services.projectRegistry,
    getResearchAdapter: (project: any) => {
      const provider = project.dreaming?.research_provider as string | undefined;
      if (!provider || provider === "off") return null;
      return createResearchAdapter({
        provider: provider as "firecrawl" | "webfetch",
        allowedDomains: project.dreaming?.allowed_domains,
      });
    },
    memoryObserve,
    judgePool,
    briefSynthesizer: briefSynthesizer ?? undefined,
    contentQualityJudge,
    phaseCostEstimates: dreamConfig.phaseCostEstimatesUsd,
  };

  Object.defineProperty(deps, "projectRegistry", {
    enumerable: true,
    configurable: true,
    get: () => services.projectRegistry,
  });

  if (services.embedder) {
    deps.onReembed = async (_id: string, body: string) =>
      (await services.embedder!.embed([body]))[0]!;
  }
  if (services.dispatchEventLog) {
    deps.dispatchEventLog = services.dispatchEventLog;
  }

  return deps;
}
