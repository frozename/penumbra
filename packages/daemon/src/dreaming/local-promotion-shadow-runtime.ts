import type { Logger } from "@penumbra/core";
import type { TypesafeFetch } from "@penumbra/typesafe";
import type { Database } from "bun:sqlite";

import { writeJudgeDecision } from "@penumbra/core";
import { randomUUID } from "node:crypto";

import type { JudgePool } from "./judge-pool.js";
import type { TypesafeShadowSeat } from "./typesafe-judge-seat.js";

import { recordSubsystemOutcome } from "../services/subsystem-health.js";
import {
  createLocalPromotionShadowSeat,
  type LocalPromotionShadowDecision,
} from "./local-promotion-shadow.js";
import { composeShadowJudgePool } from "./typesafe-judge-seat.js";

export interface LocalPromotionShadowConfig {
  baseUrl: string;
  model: string;
  revision: string;
}

interface LocalShadowServices {
  log?: Logger;
  localJudgeFetch?: TypesafeFetch;
  localJudgeNow?: () => number;
}

const RUNTIMES = new WeakMap<object, { key: string; seat: TypesafeShadowSeat }>();
export const LOCAL_PROMOTION_SHADOW_SITE = "dream.p1.local-promotion-shadow";
const SUBSYSTEM = "dream.shadow.local-system-one";

function persist(
  db: Database,
  config: LocalPromotionShadowConfig,
  row: LocalPromotionShadowDecision,
): void {
  writeJudgeDecision(db, {
    decisionId: randomUUID(),
    site: LOCAL_PROMOTION_SHADOW_SITE,
    subjectId: row.subjectId,
    mode: "shadow",
    model: config.model,
    incumbent: {
      votes:
        row.incumbentVotes?.map(({ promote, confidence, seat, abstained, error_class }) => ({
          promote,
          confidence,
          seat,
          abstained,
          error_class,
        })) ?? null,
    },
    jev: { ...row, model: config.model, provider: "local-system-one", incumbentVotes: undefined },
    usageInputTokens: row.usage?.inputTokens ?? 0,
    createdAt: row.createdAt,
  });
  recordSubsystemOutcome(db, {
    subsystem: SUBSYSTEM,
    tier: "primary",
    seat: "local-system-one",
    model: config.model,
    ok: row.failure === null,
    reason: row.failure,
  });
}

function boundedSeat(
  config: LocalPromotionShadowConfig,
  db: Database,
  services: LocalShadowServices,
): TypesafeShadowSeat {
  let loaded: Promise<TypesafeShadowSeat | null> | undefined;
  let active = false;
  let attempts = 0;
  let nextAllowed = 0;
  const now = services.localJudgeNow ?? performance.now.bind(performance);
  const load = (): Promise<TypesafeShadowSeat | null> =>
    (loaded ??= import("@penumbra/typesafe")
      .then(({ createLocalDecisionClient }) =>
        createLocalPromotionShadowSeat({
          client: createLocalDecisionClient({
            ...config,
            fetch: services.localJudgeFetch ?? fetch,
            maxConcurrency: 1,
            timeoutMs: 5000,
            maxRetries: 0,
          }),
          revision: config.revision,
          writeDecision: (row) => {
            try {
              persist(db, config, row);
            } catch {
              services.log?.warn({ reason: "sink_error" }, "local judge shadow diagnostics failed");
            }
          },
        }),
      )
      .catch(() => {
        services.log?.warn({ reason: "invalid_configuration" }, "local judge shadow disabled");
        return null;
      }));
  return {
    async shadow(args, incumbent): Promise<void> {
      if (active || attempts >= 50 || now() < nextAllowed) return;
      active = true;
      attempts++;
      nextAllowed = now() + 30_000;
      try {
        await (await load())?.shadow(args, incumbent);
      } finally {
        active = false;
      }
    },
  };
}

export function wireLocalPromotionShadow(
  incumbent: JudgePool,
  config: LocalPromotionShadowConfig | undefined,
  db: Database,
  services: LocalShadowServices,
): JudgePool {
  if (!config || !incumbent.judgeAll) return incumbent;
  const key = JSON.stringify(config);
  let runtime = RUNTIMES.get(services);
  if (runtime?.key !== key) {
    runtime = { key, seat: boundedSeat(config, db, services) };
    RUNTIMES.set(services, runtime);
  }
  return composeShadowJudgePool(incumbent, runtime.seat);
}
