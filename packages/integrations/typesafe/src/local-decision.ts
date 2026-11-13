import { createHash } from "node:crypto";

import type { TypesafeClient, TypesafeFetch } from "./client.js";
import type {
  AnswersOf,
  ChoiceAnswer,
  NoulAnswer,
  ScoreAnswer,
  TypesafeQuestion,
  TypesafeResult,
  TypesafeState,
} from "./types.js";

import { createTypesafeClient } from "./client.js";

export interface DecisionDiagnostic {
  model: string;
  revision: string;
  inputSha256: string;
  latencyMs: number;
  ok: boolean;
  failure: string | null;
  attempts: number;
}

export interface LocalDecisionOptions {
  baseUrl: string;
  model: string;
  revision: string;
  fetch: TypesafeFetch;
  apiKey?: string;
  allowRemote?: boolean;
  maxConcurrency?: number;
  maxRequestBytes?: number;
  timeoutMs?: number;
  maxRetries?: number;
  onDiagnostic?: (row: DecisionDiagnostic) => void;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(name);
  return value;
}

function endpoint(options: LocalDecisionOptions): string {
  const url = new URL(options.baseUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (!loopback && options.allowRemote !== true) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error("local decision endpoint must be an explicit server origin");
  return url.origin;
}

function distributionIsValid(probabilities: Readonly<Record<string, number | undefined>>): boolean {
  return (
    Math.abs(Object.values(probabilities).reduce<number>((sum, p) => sum + (p ?? NaN), 0) - 1) <=
    0.0001
  );
}

function strictAnswer(
  answer: NoulAnswer | ChoiceAnswer | ScoreAnswer,
  question: TypesafeQuestion,
): boolean {
  if (answer.type === "noul") return true;
  if (!distributionIsValid(answer.probabilities)) return false;
  if (answer.type === "choice") {
    const selected = answer.probabilities[answer.choice];
    return (
      selected !== undefined &&
      selected + 0.000001 >= Math.max(...Object.values(answer.probabilities).map((p) => p ?? NaN))
    );
  }
  return (
    question.type === "score" &&
    question.criteria.every((level, i) => answer.legend[String(i)] === level) &&
    Math.abs(
      answer.score -
        Object.entries(answer.probabilities).reduce(
          (sum, [level, p]) => sum + Number(level) * p,
          0,
        ),
    ) <= 0.0001
  );
}

function strictAnswers(
  answers: Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer>,
  questions: Record<string, TypesafeQuestion>,
): boolean {
  return Object.entries(questions).every(([id, question]) => {
    const answer = answers[id];
    return answer !== undefined && strictAnswer(answer, question);
  });
}

/** Experimental transport only. Failures remain abstentions; callers own fallback policy. */
export function createLocalDecisionClient(options: LocalDecisionOptions): TypesafeClient {
  const baseUrl = endpoint(options);
  if (!options.model.trim() || !options.revision.trim())
    throw new Error("model and revision are required");
  const maxConcurrency = positiveInteger(options.maxConcurrency ?? 1, "maxConcurrency");
  const maxRequestBytes = positiveInteger(options.maxRequestBytes ?? 65_536, "maxRequestBytes");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 5000, "timeoutMs");
  const maxRetries = options.maxRetries ?? 0;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 2)
    throw new RangeError("maxRetries");
  const transport = createTypesafeClient({
    settings: {
      enabled: true,
      apiKey: options.apiKey ?? "",
      keySource: "env",
      baseUrl,
      model: options.model,
      timeoutMs,
      judgePromotion: "shadow",
    },
    fetch: (url, init) => {
      const localInit = { ...init, redirect: "error" as const };
      if (!options.apiKey) delete localInit.headers.Authorization;
      return options.fetch(url, localInit);
    },
    maxRetries,
    backoffInitialMs: 25,
    backoffMaxMs: 100,
  });
  let inFlight = 0;
  return {
    async evaluate<M extends Record<string, TypesafeQuestion>>(req: {
      state: TypesafeState;
      questions: M;
      signal?: AbortSignal;
    }): Promise<TypesafeResult<AnswersOf<M>>> {
      const started = performance.now();
      let body: string;
      try {
        body = JSON.stringify({ state: req.state, questions: req.questions, model: options.model });
      } catch {
        return { ok: false, kind: "invalid_request", status: null, attempts: 0 };
      }
      const inputSha256 = createHash("sha256").update(body).digest("hex");
      const report = (result: TypesafeResult<unknown>): void => {
        try {
          options.onDiagnostic?.({
            model: options.model,
            revision: options.revision,
            inputSha256,
            latencyMs: performance.now() - started,
            ok: result.ok,
            failure: result.ok ? null : result.kind,
            attempts: result.attempts,
          });
        } catch {
          /* A telemetry failure must not change a decision. */
        }
      };
      if (Buffer.byteLength(body) > maxRequestBytes) {
        const result = { ok: false, kind: "invalid_request", status: null, attempts: 0 } as const;
        report(result);
        return result;
      }
      if (inFlight >= maxConcurrency) {
        const result = { ok: false, kind: "busy", status: null, attempts: 0 } as const;
        report(result);
        return result;
      }
      inFlight++;
      const controller = new AbortController();
      const signal = req.signal
        ? AbortSignal.any([req.signal, controller.signal])
        : controller.signal;
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      let onAbort: () => void = () => undefined;
      try {
        const deadline = new Promise<TypesafeResult<never>>((resolve): void => {
          onAbort = (): void => {
            resolve({ ok: false, kind: "timeout", status: null, attempts: 0 });
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        const result = await Promise.race([deadline, transport.evaluate({ ...req, signal })]);
        if (
          result.ok &&
          (result.model !== options.model ||
            result.usage.inputTokens < 0 ||
            result.usage.outputTokens < 0 ||
            !strictAnswers(result.answers, req.questions))
        ) {
          const invalid = {
            ok: false,
            kind: "invalid_response",
            status: null,
            attempts: result.attempts,
          } as const;
          report(invalid);
          return invalid;
        }
        report(result);
        return result;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        controller.abort();
        inFlight--;
      }
    },
  };
}
