import type { TypesafeSettings } from "./config.js";

import {
  type AnswersOf,
  type SystemOneResponse,
  SystemOneResponseSchema,
  type SystemOneWireAnswer,
  TYPESAFE_SYSTEMONE_PATH,
  type TypesafeFailureKind,
  type TypesafeQuestion,
  type TypesafeResult,
  type TypesafeState,
} from "./types.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_INITIAL_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 5000;
const BACKOFF_JITTER = 0.25;

export type TypesafeFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface TypesafeClientOptions {
  settings: TypesafeSettings;
  /** REQUIRED: no globalThis.fetch default, so a test cannot make a real paid call. */
  fetch: TypesafeFetch;
  maxRetries?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface TypesafeClient {
  evaluate<M extends Record<string, TypesafeQuestion>>(req: {
    state: TypesafeState;
    questions: M;
    signal?: AbortSignal;
  }): Promise<TypesafeResult<AnswersOf<M>>>;
}

interface Deps {
  settings: TypesafeSettings;
  fetchImpl: TypesafeFetch;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  random: () => number;
  maxRetries: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
}

interface AttemptCtx {
  url: string;
  body: string;
  apiKey: string;
  signal: AbortSignal;
  deadlineAt: number;
  questions: Record<string, TypesafeQuestion>;
}

interface PendingFailure {
  kind: TypesafeFailureKind;
  status: number | null;
  retryAfterMs: number | null;
}

type AttemptOutcome =
  | { type: "response"; response: Response }
  | { type: "aborted" }
  | { type: "error" };

export function createTypesafeClient(options: TypesafeClientOptions): TypesafeClient {
  const deps: Deps = {
    settings: options.settings,
    fetchImpl: options.fetch,
    sleep: options.sleep ?? defaultSleep,
    now: options.now ?? Date.now,
    random: options.random ?? Math.random,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    backoffInitialMs: options.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS,
    backoffMaxMs: options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
  };
  return {
    evaluate<M extends Record<string, TypesafeQuestion>>(req: {
      state: TypesafeState;
      questions: M;
      signal?: AbortSignal;
    }): Promise<TypesafeResult<AnswersOf<M>>> {
      return evaluateRequest(deps, req);
    },
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve): void => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout((): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function evaluateRequest<M extends Record<string, TypesafeQuestion>>(
  deps: Deps,
  req: { state: TypesafeState; questions: M; signal?: AbortSignal },
): Promise<TypesafeResult<AnswersOf<M>>> {
  const { settings } = deps;
  if (!settings.enabled) {
    return { ok: false, kind: "disabled", status: null, attempts: 0 };
  }
  const questions: Record<string, TypesafeQuestion> = req.questions;
  let body: string;
  try {
    if (!requestIsValid(questions)) {
      return { ok: false, kind: "invalid_request", status: null, attempts: 0 };
    }
    body = JSON.stringify({ state: req.state, model: settings.model, questions });
  } catch {
    return { ok: false, kind: "invalid_request", status: null, attempts: 0 };
  }
  const url = `${settings.baseUrl.replace(/\/+$/, "")}${TYPESAFE_SYSTEMONE_PATH}`;
  const deadlineAt = deps.now() + settings.timeoutMs;
  const controller = new AbortController();
  const signal =
    req.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, req.signal]);
  const counter = { attempts: 0 };
  const timer = setTimeout((): void => {
    controller.abort();
  }, settings.timeoutMs);
  try {
    return await attemptLoop<M>(deps, {
      url,
      body,
      apiKey: settings.apiKey,
      signal,
      deadlineAt,
      questions,
      counter,
    });
  } catch {
    return { ok: false, kind: "transport", status: null, attempts: counter.attempts };
  } finally {
    clearTimeout(timer);
  }
}

interface LoopCtx extends AttemptCtx {
  counter: { attempts: number };
}

type StepOutcome<M extends Record<string, TypesafeQuestion>> =
  | { type: "finished"; result: TypesafeResult<AnswersOf<M>> }
  | { type: "retry"; pending: PendingFailure };

async function attemptLoop<M extends Record<string, TypesafeQuestion>>(
  deps: Deps,
  ctx: LoopCtx,
): Promise<TypesafeResult<AnswersOf<M>>> {
  for (;;) {
    if (ctx.signal.aborted) {
      return { ok: false, kind: "timeout", status: null, attempts: ctx.counter.attempts };
    }
    ctx.counter.attempts += 1;
    const step = await resolveOutcome<M>(deps, ctx);
    if (step.type === "finished") {
      return step.result;
    }
    const { pending } = step;
    if (ctx.counter.attempts > deps.maxRetries) {
      return {
        ok: false,
        kind: pending.kind,
        status: pending.status,
        attempts: ctx.counter.attempts,
      };
    }
    const delay = pending.retryAfterMs ?? backoffDelay(deps, ctx.counter.attempts);
    if (deps.now() + delay >= ctx.deadlineAt) {
      return {
        ok: false,
        kind: pending.kind,
        status: pending.status,
        attempts: ctx.counter.attempts,
      };
    }
    try {
      await deps.sleep(delay, ctx.signal);
    } catch {
      // A rejected sleep is an abort; the loop head resolves it as timeout.
    }
  }
}

async function resolveOutcome<M extends Record<string, TypesafeQuestion>>(
  deps: Deps,
  ctx: LoopCtx,
): Promise<StepOutcome<M>> {
  const outcome = await attemptOnce(deps, ctx);
  if (outcome.type === "aborted") {
    return {
      type: "finished",
      result: { ok: false, kind: "timeout", status: null, attempts: ctx.counter.attempts },
    };
  }
  if (outcome.type === "error") {
    return { type: "retry", pending: { kind: "transport", status: null, retryAfterMs: null } };
  }
  const { response } = outcome;
  if (response.status < 200 || response.status > 299) {
    const classified = classifyStatus(response.status);
    if (!classified.retriable) {
      return {
        type: "finished",
        result: {
          ok: false,
          kind: classified.kind,
          status: response.status,
          attempts: ctx.counter.attempts,
        },
      };
    }
    return {
      type: "retry",
      pending: {
        kind: classified.kind,
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers, deps.now()),
      },
    };
  }
  const data = await parseResponseBody(response, ctx.questions);
  if (data === null) {
    return {
      type: "finished",
      result: {
        ok: false,
        kind: "invalid_response",
        status: response.status,
        attempts: ctx.counter.attempts,
      },
    };
  }
  return {
    type: "finished",
    result: {
      ok: true,
      model: data.model,
      answers: data.answers as unknown as AnswersOf<M>,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
      attempts: ctx.counter.attempts,
    },
  };
}

function backoffDelay(deps: Deps, attempts: number): number {
  return (
    Math.min(deps.backoffInitialMs * 2 ** (attempts - 1), deps.backoffMaxMs) *
    (1 - deps.random() * BACKOFF_JITTER)
  );
}

async function attemptOnce(deps: Deps, ctx: AttemptCtx): Promise<AttemptOutcome> {
  try {
    const response = await deps.fetchImpl(ctx.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: ctx.body,
      signal: ctx.signal,
    });
    return { type: "response", response };
  } catch {
    return ctx.signal.aborted ? { type: "aborted" } : { type: "error" };
  }
}

function classifyStatus(status: number): { kind: TypesafeFailureKind; retriable: boolean } {
  if (status === 401 || status === 403) {
    return { kind: "auth", retriable: false };
  }
  if (status === 408) {
    return { kind: "timeout", retriable: true };
  }
  if (status === 429) {
    return { kind: "rate_limited", retriable: true };
  }
  if (status >= 500 && status <= 599) {
    return { kind: "server", retriable: true };
  }
  return { kind: "invalid_request", retriable: false };
}

function parseRetryAfter(headers: Headers, now: number): number | null {
  const rawMs = headers.get("retry-after-ms");
  if (rawMs !== null) {
    const ms = Number(rawMs);
    if (Number.isFinite(ms) && ms >= 0) {
      return ms;
    }
  }
  const raw = headers.get("retry-after");
  if (raw === null) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - now);
  }
  return null;
}

function requestIsValid(questions: Record<string, TypesafeQuestion>): boolean {
  const entries = Object.entries(questions);
  if (entries.length === 0) {
    return false;
  }
  for (const [, question] of entries) {
    if (!questionIsValid(question)) {
      return false;
    }
  }
  return true;
}

function questionIsValid(question: TypesafeQuestion): boolean {
  switch (question.type) {
    case "noul":
      return true;
    case "choice":
      return Object.keys(question.criteria).length >= 2;
    case "score":
      return question.criteria.length >= 2;
    default:
      return false;
  }
}

async function parseResponseBody(
  response: Response,
  questions: Record<string, TypesafeQuestion>,
): Promise<SystemOneResponse | null> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return null;
  }
  const parsed = SystemOneResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return validateAnswers(parsed.data.answers, questions) ? parsed.data : null;
}

function inUnit(n: number): boolean {
  return n >= 0 && n <= 1;
}

function validateAnswers(
  answers: Record<string, SystemOneWireAnswer>,
  questions: Record<string, TypesafeQuestion>,
): boolean {
  const entries = Object.entries(questions);
  if (Object.keys(answers).length !== entries.length) {
    return false;
  }
  for (const [id, question] of entries) {
    const answer = answers[id];
    if (answer === undefined) {
      return false;
    }
    if (answer.type !== question.type) {
      return false;
    }
    if (!answerMatchesQuestion(answer, question)) {
      return false;
    }
  }
  return true;
}

function answerMatchesQuestion(answer: SystemOneWireAnswer, question: TypesafeQuestion): boolean {
  if (answer.type === "noul") {
    return inUnit(answer.noul);
  }
  if (answer.type === "choice" && question.type === "choice") {
    return (
      inUnit(answer.confidence) &&
      Object.hasOwn(question.criteria, answer.choice) &&
      Object.values(answer.probabilities).every(inUnit)
    );
  }
  if (answer.type === "score") {
    return inUnit(answer.confidence) && Object.values(answer.probabilities).every(inUnit);
  }
  return true;
}
