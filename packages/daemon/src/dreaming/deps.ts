import type { Database } from "bun:sqlite";

import {
  type DispatchEventInput,
  type LlmCandidate,
  type Logger,
  readSubscriptionPressure,
  resolveRoleLlmCandidates,
  tryResolveLlmProvider,
  writeJudgeDecision,
} from "@penumbra/core";
import { randomUUID } from "node:crypto";

import type { DreamCycleDeps, ProjectRegistryEntry } from "./cycle.js";

import { loadAgentChatConfig, resolveAgentChatConfigPath } from "../agentchat-config.js";
import { isAnyProviderOverPressure } from "../pressure.js";
import { createResearchAdapter } from "../research/firecrawl-adapter.js";
import { createBriefSynthesizerFromAgentchat } from "./brief-synthesizer.js";
import { type DreamConfig, resolveP1JevShadowEstimateUsd } from "./config.js";
import { ContentQualityJudge } from "./curator/content-quality-judge.js";
import { createDreamingJudgePoolFromAgentchat } from "./dreaming-judge-pool.js";
import { type JudgeVote, type SerializedJudgeVote, StubJudgePool } from "./judge-pool.js";
import {
  createCachedDreamingRewriterInventory,
  DREAMING_REWRITER_LOCAL_SECONDARY_MODEL,
} from "./rewriter-inventory.js";
import {
  composeShadowJudgePool,
  createLazyShadowSeat,
  createLazyTypesafeJudgeLoader,
  createPromotionVeto,
  createTypesafeShadowSeat,
  importTypesafeModule,
  type JevShadowDecision,
  type JevShadowJudgeLoader,
  type TypesafeModuleLike,
} from "./typesafe-judge-seat.js";

interface DreamingResearchConfig {
  research_provider?: "firecrawl" | "webfetch" | "off";
  allowed_domains?: string[];
}

interface ProjectRegistryLike {
  get(id: string): ProjectRegistryEntry | undefined;
  list(): ProjectRegistryEntry[];
}

interface DreamDepsServices {
  projectRegistry?: ProjectRegistryLike;
  embedder?: { embed(bodies: string[]): Promise<Float32Array[]> };
  dispatchEventLog?: { record(event: DispatchEventInput): void };
  log?: Logger;
  // Test seam only: production always resolves the lazy import() itself.
  loadTypesafeModule?: () => Promise<TypesafeModuleLike>;
  // Test seam only: production leaves this unset and the judge pool uses the
  // global fetch.
  judgeFetch?: typeof fetch;
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
    return withDefaultLocalRewriterSecondary(
      resolveRoleLlmCandidates({
        roleTag,
        agentchatConfig: loadAgentChatConfig(),
        fallbackCandidates,
      }),
      dreamConfig,
    );
  } catch (err) {
    log?.warn(
      { err, configDir: resolveAgentChatConfigPath(), roleTag },
      "dreaming: failed to resolve rewriter role candidates; using legacy environment candidate",
    );
    return withDefaultLocalRewriterSecondary(fallbackCandidates, dreamConfig);
  }
}

function withDefaultLocalRewriterSecondary(
  candidates: LlmCandidate[],
  dreamConfig: DreamConfig,
): LlmCandidate[] {
  if (!dreamConfig.rewriterBaseUrl) return candidates;
  const provider = tryResolveLlmProvider(dreamConfig.rewriterBaseUrl) ?? "unknown";
  if (provider !== "local") return candidates;
  if (
    candidates.some(
      (candidate) =>
        candidate.baseUrl === dreamConfig.rewriterBaseUrl &&
        candidate.model === DREAMING_REWRITER_LOCAL_SECONDARY_MODEL,
    )
  ) {
    return candidates;
  }
  return [
    ...candidates,
    {
      name: DREAMING_REWRITER_LOCAL_SECONDARY_MODEL,
      baseUrl: dreamConfig.rewriterBaseUrl,
      model: DREAMING_REWRITER_LOCAL_SECONDARY_MODEL,
      provider,
      auth: { source: "none" },
    },
  ];
}

export function buildDreamCycleDeps(
  services: DreamDepsServices,
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

  const realJudgePool = createDreamingJudgePoolFromAgentchat(
    { log: services.log },
    services.judgeFetch,
  );
  const judgePool = realJudgePool ?? new StubJudgePool();

  const briefSynthesizer = createBriefSynthesizerFromAgentchat({ log: services.log });
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
    rewriterInventory: createCachedDreamingRewriterInventory(),
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
  if (
    (dreamConfig.typesafeJudgePromotion === "shadow" ||
      dreamConfig.typesafeJudgePromotion === "veto") &&
    dreamConfig.typesafeEnv !== undefined
  ) {
    wireTypesafeShadow(deps, services, db, dreamConfig);
  }

  return deps;
}

// One loader per services object: serve.ts passes the same bag to the boot
// build and every 60s idle rebuild, so the import, the settings resolution and
// any keychain read each run once per daemon process.
const TYPESAFE_JUDGE_LOADERS = new WeakMap<object, JevShadowJudgeLoader>();

function wireTypesafeShadow(
  deps: DreamCycleDeps,
  services: DreamDepsServices,
  db: Database,
  dreamConfig: DreamConfig,
): void {
  const env = dreamConfig.typesafeEnv;
  if (env === undefined) return;
  let loader = TYPESAFE_JUDGE_LOADERS.get(services);
  if (loader === undefined) {
    loader = createLazyTypesafeJudgeLoader(services.loadTypesafeModule ?? importTypesafeModule, {
      env,
      log: services.log,
    });
    TYPESAFE_JUDGE_LOADERS.set(services, loader);
    // Resolve at boot so a disabled reason is logged once, at boot. The error
    // itself is never logged: settings (and so a thrown message) can carry the
    // API key.
    void loader().catch(() => {
      services.log?.warn({ reason: "loader_rejected" }, "typesafe shadow judge loader rejected");
    });
  }
  const incumbent = deps.judgePool;
  if (incumbent === undefined) return;
  deps.judgePool = composeShadowJudgePool(
    incumbent,
    createLazyShadowSeat(loader, (loadJudge) =>
      createTypesafeShadowSeat({
        db,
        loadJudge,
        writeDecision: (row) => {
          writeShadowJudgeDecision(db, row);
        },
        getCostMeter: () => deps.costMeter,
        estimateUsd: resolveP1JevShadowEstimateUsd(dreamConfig.phaseCostEstimatesUsd),
      }),
    ),
  );
  if (dreamConfig.typesafeJudgePromotion === "veto") {
    deps.promotionVeto = createPromotionVeto({
      db,
      loadJudge: loader,
      getCostMeter: () => deps.costMeter,
      estimateUsd: resolveP1JevShadowEstimateUsd(dreamConfig.phaseCostEstimatesUsd),
    });
  }
}

// The audit row keeps only the ballot fields: rationale is model free text and
// is dropped exactly as serializeJudgeVotes drops it for dream_actions.
function toAuditVote(vote: JudgeVote): SerializedJudgeVote {
  return {
    ...(vote.seat === undefined ? {} : { seat: vote.seat }),
    promote: vote.promote,
    confidence: vote.confidence,
    ...(vote.abstained === true ? { abstained: true } : {}),
    ...(vote.error_class === undefined ? {} : { error_class: vote.error_class }),
  };
}

function writeShadowJudgeDecision(db: Database, row: JevShadowDecision): void {
  writeJudgeDecision(db, {
    decisionId: randomUUID(),
    site: row.site,
    subjectId: row.subjectId,
    mode: "shadow",
    model: row.model,
    incumbent: {
      votes: row.incumbentVotes === null ? null : row.incumbentVotes.map(toAuditVote),
    },
    jev: {
      answers: row.answers,
      pPromote: row.pPromote,
      shadowPromote: row.shadowPromote,
      inputSha256: row.inputSha256,
      usd: row.usd,
      latencyMs: row.latencyMs,
      outputTokens: row.usage.outputTokens,
    },
    usageInputTokens: row.usage.inputTokens,
    createdAt: row.createdAt,
  });
}
