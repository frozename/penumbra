import type { Database } from "bun:sqlite";

import { type DispatchEventInput, type Logger, readSubscriptionPressure } from "@penumbra/core";
import { randomUUID } from "node:crypto";

import type { DreamConfig } from "./config.js";
import type { DreamCycleDeps, ProjectRegistryEntry } from "./cycle.js";

import { isAnyProviderOverPressure } from "../pressure.js";
import { createResearchAdapter } from "../research/firecrawl-adapter.js";
import {
  resolveRoleLlmCandidates,
  type LlmCandidate,
  tryResolveLlmProvider,
} from "../../../core/src/services/llm-candidates.js";
import { loadAgentChatConfig, resolveAgentChatConfigPath } from "../agentchat-config.js";
import { createBriefSynthesizerFromAgentchat } from "./brief-synthesizer.js";
import { ContentQualityJudge } from "./curator/content-quality-judge.js";
import { createDreamingJudgePoolFromAgentchat } from "./dreaming-judge-pool.js";
import { StubJudgePool } from "./judge-pool.js";

interface DreamingResearchConfig {
  research_provider?: "firecrawl" | "webfetch" | "off";
  allowed_domains?: string[];
}

interface ProjectRegistryLike {
  get(id: string): ProjectRegistryEntry | undefined;
  list(): ProjectRegistryEntry[];
}

export function createDreamingRewriterCandidates(
  dreamConfig: DreamConfig,
  log?: Logger,
): LlmCandidate[] {
  const fallbackCandidates =
    dreamConfig.rewriterBaseUrl && dreamConfig.rewriterModel
      ? [
          {
            name: dreamConfig.rewriterModel,
            baseUrl: dreamConfig.rewriterBaseUrl,
            model: dreamConfig.rewriterModel,
            provider: tryResolveLlmProvider(dreamConfig.rewriterBaseUrl) ?? "unknown",
            auth: { source: "none" as const },
          },
        ]
      : [];
  const roleTag = process.env["PENUMBRA_DREAMING_REWRITER_ROLE"] ?? "dreaming-rewriter";
  try {
    return resolveRoleLlmCandidates({
      roleTag,
      agentchatConfig: loadAgentChatConfig(),
      fallbackCandidates,
    });
  } catch (err) {
    log?.warn(
      { err, configDir: resolveAgentChatConfigPath(), roleTag },
      "dreaming: failed to resolve rewriter role candidates; using legacy environment candidate",
    );
    return fallbackCandidates;
  }
}

export function buildDreamCycleDeps(
  services: {
    projectRegistry?: ProjectRegistryLike;
    embedder?: { embed(bodies: string[]): Promise<Float32Array[]> };
    dispatchEventLog?: { record(event: DispatchEventInput): void };
    log?: Logger;
  },
  db: Database,
  dreamConfig: DreamConfig,
): DreamCycleDeps {
  const memoryObserve = (
    briefMarkdown: string,
    projectId: string,
    cycleId: string,
    opts?: { session_id?: string | null },
  ): Promise<{ memory_id: string }> => {
    const memory_id = randomUUID();
    const nowIso = new Date().toISOString();
    const sourceSessionIds = opts?.session_id ? JSON.stringify([opts.session_id]) : "[]";
    db.prepare(
      `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, ?, 'system', 'brief', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      memory_id,
      projectId,
      sourceSessionIds,
      nowIso,
      nowIso,
      `Brief: ${projectId} (${cycleId.slice(0, 8)})`,
      briefMarkdown,
      nowIso,
      nowIso,
    );
    return Promise.resolve({ memory_id });
  };

  const realJudgePool = createDreamingJudgePoolFromAgentchat();
  const judgePool = realJudgePool ?? new StubJudgePool();

  const briefSynthesizer = createBriefSynthesizerFromAgentchat();
  const rewriterCandidates = createDreamingRewriterCandidates(dreamConfig, services.log);

  const contentQualityJudge =
    dreamConfig.contentQualityThreshold > 0
      ? new ContentQualityJudge({ threshold: dreamConfig.contentQualityThreshold })
      : undefined;

  const embedder = services.embedder;
  const dispatchEventLog = services.dispatchEventLog;

  const deps: DreamCycleDeps = {
    projectRegistry: services.projectRegistry,
    getResearchAdapter: (project: ProjectRegistryEntry) => {
      const dreaming = (project.dreaming ?? {}) as DreamingResearchConfig;
      const provider = dreaming.research_provider;
      if (!provider || provider === "off") return null;
      return createResearchAdapter({
        provider,
        allowedDomains: dreaming.allowed_domains,
      });
    },
    memoryObserve,
    judgePool,
    briefSynthesizer: briefSynthesizer ?? undefined,
    rewriterCandidates,
    contentQualityJudge,
    pressureGuard: {
      check: (): Promise<{ anyThrottled: boolean }> =>
        Promise.resolve({
          anyThrottled: isAnyProviderOverPressure(readSubscriptionPressure(db)),
        }),
    },
    phaseCostEstimates: dreamConfig.phaseCostEstimatesUsd,
    log: services.log,
  };

  Object.defineProperty(deps, "projectRegistry", {
    enumerable: true,
    configurable: true,
    get: () => services.projectRegistry,
  });

  if (embedder) {
    deps.onReembed = async (_id: string, text: string): Promise<Float32Array> => {
      const vectors = await embedder.embed([text]);
      const first = vectors[0];
      if (!first) throw new Error("embedder returned no vectors");
      return first;
    };
  }
  if (dispatchEventLog) {
    deps.dispatchEventLog = dispatchEventLog;
  }

  return deps;
}
