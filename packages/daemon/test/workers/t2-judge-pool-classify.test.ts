import { describe, expect, test } from "bun:test";

import {
  classifyJudgeHttpError,
  createJudgePool,
  isContextOverflow,
  type JudgeEntry,
  JudgeError,
  type JudgePoolOpts,
} from "@src/workers/t2-judge-pool.js";

type FetchMock = NonNullable<JudgePoolOpts["fetch"]>;
type FetchImpl = (
  input: Parameters<FetchMock>[0],
  init?: Parameters<FetchMock>[1],
) => Promise<Response>;

const NOOP_LOG = {
  info: (): undefined => undefined,
  warn: (): undefined => undefined,
  error: (): undefined => undefined,
};

// `typeof fetch` requires `preconnect`; bare mock functions don't satisfy it.
function asFetchMock(impl: FetchImpl): FetchMock {
  return Object.assign(impl, { preconnect: (): void => undefined });
}

function judgeErrJson(error: Record<string, unknown>): string {
  return JSON.stringify({ error });
}

const OVERFLOW_BODY = judgeErrJson({
  type: "exceed_context_size_error",
  n_prompt_tokens: 9000,
  n_ctx: 8192,
});

function okJudgeResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
    status: 200,
  });
}

function fetchInputText(input: Parameters<FetchMock>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function judge(baseUrl: string, apiKey = ""): JudgeEntry {
  return { name: "j", baseUrl, apiKey, model: "m" };
}

interface Captured {
  url?: string;
  init?: RequestInit;
}

function capturePool(entry: JudgeEntry): {
  pool: ReturnType<typeof createJudgePool>;
  captured: Captured;
} {
  const captured: Captured = {};
  const pool = createJudgePool({
    judges: [entry],
    log: NOOP_LOG,
    timeoutMs: 60_000,
    fetch: asFetchMock((input, init) => {
      captured.url = fetchInputText(input);
      captured.init = init;
      return Promise.resolve(okJudgeResponse());
    }),
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });
  return { pool, captured };
}

function failingPool(status: number, body: string): ReturnType<typeof createJudgePool> {
  return createJudgePool({
    judges: [{ name: "a", baseUrl: "http://h:1", apiKey: "", model: "m" }],
    log: NOOP_LOG,
    timeoutMs: 60_000,
    fetch: asFetchMock(() => Promise.resolve(new Response(body, { status }))),
    promptBuilder: (transcript) => transcript,
    parseResponse: () => [],
  });
}

function readHeaders(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe("classifyJudgeHttpError JSON body", () => {
  test("type field with numeric metrics keeps both metrics", () => {
    expect(classifyJudgeHttpError(400, OVERFLOW_BODY)).toEqual({
      isOverflow: true,
      nPromptTokens: 9000,
      nCtx: 8192,
    });
  });

  test("code field (no type) keeps both metrics", () => {
    const body = judgeErrJson({
      code: "exceed_context_size_error",
      n_prompt_tokens: 9000,
      n_ctx: 8192,
    });
    expect(classifyJudgeHttpError(400, body)).toEqual({
      isOverflow: true,
      nPromptTokens: 9000,
      nCtx: 8192,
    });
  });

  test("numeric strings are coerced to numbers", () => {
    const body = judgeErrJson({
      type: "exceed_context_size_error",
      n_prompt_tokens: "9000",
      n_ctx: "8192",
    });
    expect(classifyJudgeHttpError(400, body)).toEqual({
      isOverflow: true,
      nPromptTokens: 9000,
      nCtx: 8192,
    });
  });

  test("non-numeric prompt token drops only the prompt metric", () => {
    const body = judgeErrJson({
      type: "exceed_context_size_error",
      n_prompt_tokens: "lots",
      n_ctx: 8192,
    });
    const result = classifyJudgeHttpError(400, body);
    expect(result.isOverflow).toBe(true);
    expect(result.nPromptTokens).toBe(undefined);
    expect(result.nCtx).toBe(8192);
  });

  test("n_ctx below 1000 drops both metrics even when prompt exceeds ctx", () => {
    const body = judgeErrJson({
      type: "exceed_context_size_error",
      n_prompt_tokens: 9000,
      n_ctx: 512,
    });
    const result = classifyJudgeHttpError(400, body);
    expect(result.isOverflow).toBe(true);
    expect(result.nPromptTokens).toBe(undefined);
    expect(result.nCtx).toBe(undefined);
  });

  test("n_ctx exactly 1000 keeps both metrics", () => {
    const body = judgeErrJson({
      type: "exceed_context_size_error",
      n_prompt_tokens: 9000,
      n_ctx: 1000,
    });
    expect(classifyJudgeHttpError(400, body)).toEqual({
      isOverflow: true,
      nPromptTokens: 9000,
      nCtx: 1000,
    });
  });

  test("prompt equal to ctx drops both metrics", () => {
    const body = judgeErrJson({
      type: "exceed_context_size_error",
      n_prompt_tokens: 8192,
      n_ctx: 8192,
    });
    const result = classifyJudgeHttpError(400, body);
    expect(result.isOverflow).toBe(true);
    expect(result.nPromptTokens).toBe(undefined);
    expect(result.nCtx).toBe(undefined);
  });

  test("prompt below ctx drops both metrics", () => {
    const body = judgeErrJson({
      type: "exceed_context_size_error",
      n_prompt_tokens: 4000,
      n_ctx: 8192,
    });
    const result = classifyJudgeHttpError(400, body);
    expect(result.isOverflow).toBe(true);
    expect(result.nPromptTokens).toBe(undefined);
    expect(result.nCtx).toBe(undefined);
  });

  test("parsed JSON body never falls through to the text regex", () => {
    const body = judgeErrJson({
      type: "invalid_request",
      message: "exceeds the available context size",
    });
    expect(classifyJudgeHttpError(400, body)).toEqual({ isOverflow: false });
  });

  test("top-level message without error object is not overflow", () => {
    const body = JSON.stringify({ message: "exceed_context_size_error" });
    expect(classifyJudgeHttpError(400, body)).toEqual({ isOverflow: false });
  });

  test("string error field is not overflow", () => {
    const body = JSON.stringify({ error: "exceed_context_size_error" });
    expect(classifyJudgeHttpError(400, body)).toEqual({ isOverflow: false });
  });

  test("JSON classification ignores the status", () => {
    expect(classifyJudgeHttpError(503, OVERFLOW_BODY)).toEqual({
      isOverflow: true,
      nPromptTokens: 9000,
      nCtx: 8192,
    });
  });
});

describe("classifyJudgeHttpError text fallback", () => {
  test("parenthesised tokens form yields metrics", () => {
    const body = "request (13857 tokens) exceeds the available context size (8192 tokens)";
    expect(classifyJudgeHttpError(400, body)).toEqual({
      isOverflow: true,
      nPromptTokens: 13857,
      nCtx: 8192,
    });
  });

  test("n_prompt_tokens=/n_ctx= form yields metrics", () => {
    const body = "exceed_context_size_error n_prompt_tokens=9000 n_ctx=8192";
    expect(classifyJudgeHttpError(400, body)).toEqual({
      isOverflow: true,
      nPromptTokens: 9000,
      nCtx: 8192,
    });
  });

  test("n_ctx=0 fails the n_ctx > 0 guard and drops metrics", () => {
    const body = "exceed_context_size_error n_prompt_tokens=9000 n_ctx=0";
    const result = classifyJudgeHttpError(400, body);
    expect(result.isOverflow).toBe(true);
    expect(result.nPromptTokens).toBe(undefined);
    expect(result.nCtx).toBe(undefined);
  });

  test("phrase without numbers yields overflow without metrics", () => {
    const result = classifyJudgeHttpError(400, "exceeds the available context size");
    expect(result.isOverflow).toBe(true);
    expect(result.nPromptTokens).toBe(undefined);
    expect(result.nCtx).toBe(undefined);
  });

  test("phrase match is case-insensitive", () => {
    const result = classifyJudgeHttpError(400, "EXCEEDS THE AVAILABLE CONTEXT SIZE");
    expect(result.isOverflow).toBe(true);
  });

  test.each([
    [499, true],
    [500, false],
    [399, false],
  ] as [number, boolean][])(
    "status window: %i falls inside 400..499 membership gives isOverflow %s",
    (status: number, expected: boolean) => {
      const result = classifyJudgeHttpError(status, "exceeds the available context size");
      expect(result.isOverflow).toBe(expected);
    },
  );

  test("plain 400 text without the phrase is not overflow", () => {
    expect(classifyJudgeHttpError(400, "bad request")).toEqual({ isOverflow: false });
  });
});

describe("isContextOverflow", () => {
  test("JudgeError flag false beats an overflow-phrase message", () => {
    const err = new JudgeError("exceed_context_size_error", { isContextOverflow: false });
    expect(isContextOverflow(err)).toBe(false);
  });

  test("JudgeError flag true beats a plain message", () => {
    const err = new JudgeError("boom", { isContextOverflow: true });
    expect(isContextOverflow(err)).toBe(true);
  });

  test("plain Error own flag false beats an overflow-phrase message", () => {
    const err = Object.assign(new Error("exceeds the available context size"), {
      isContextOverflow: false,
    });
    expect(isContextOverflow(err)).toBe(false);
  });

  test("plain Error own flag true with a plain message", () => {
    const err = Object.assign(new Error("boom"), { isContextOverflow: true });
    expect(isContextOverflow(err)).toBe(true);
  });

  test("plain Error non-boolean flag with a plain message returns false", () => {
    const err = Object.assign(new Error("boom"), { isContextOverflow: "yes" });
    expect(isContextOverflow(err)).toBe(false);
  });

  test("plain Error non-boolean flag falls back to the message regex", () => {
    const err = Object.assign(new Error("exceed_context_size_error"), {
      isContextOverflow: "yes",
    });
    expect(isContextOverflow(err)).toBe(true);
  });

  test("non-Error values return false", () => {
    expect(isContextOverflow({ message: "exceed_context_size_error" })).toBe(false);
    expect(isContextOverflow(null)).toBe(false);
    expect(isContextOverflow(42)).toBe(false);
  });
});

describe("createJudgePool request shaping", () => {
  test.each([
    ["http://h:1", "http://h:1/v1/chat/completions"],
    ["http://h:1/", "http://h:1/v1/chat/completions"],
    ["http://h:1/v1", "http://h:1/v1/chat/completions"],
    ["http://h:1/v1///", "http://h:1/v1/chat/completions"],
    ["http://h:1/api", "http://h:1/api/v1/chat/completions"],
  ] as [string, string][])(
    "baseUrl %s posts to %s",
    async (baseUrl: string, expectedUrl: string) => {
      const { pool, captured } = capturePool(judge(baseUrl));
      await pool.invoke("t");
      expect(captured.url).toBe(expectedUrl);
    },
  );

  test("apiKey sends a Bearer authorization header", async () => {
    const { pool, captured } = capturePool(judge("http://h:1", "k"));
    await pool.invoke("t");
    expect(readHeaders(captured.init).Authorization).toBe("Bearer k");
  });

  test("empty apiKey sends no authorization header", async () => {
    const { pool, captured } = capturePool(judge("http://h:1", ""));
    await pool.invoke("t");
    expect(readHeaders(captured.init).Authorization).toBe(undefined);
  });
});

describe("createJudgePool non-ok propagation", () => {
  test("400 overflow body rejects with JudgeError carrying metrics and message", async () => {
    let thrown: unknown;
    try {
      await failingPool(400, OVERFLOW_BODY).invoke("t");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(JudgeError);
    if (thrown instanceof JudgeError) {
      expect(thrown.isContextOverflow).toBe(true);
      expect(thrown.nPromptTokens).toBe(9000);
      expect(thrown.nCtx).toBe(8192);
      expect(thrown.message).toBe(`judge a returned 400: ${OVERFLOW_BODY}`);
    }
  });

  test("below-1000 sanity rule reaches the thrown JudgeError", async () => {
    const body = judgeErrJson({
      type: "exceed_context_size_error",
      n_prompt_tokens: 9000,
      n_ctx: 512,
    });
    let thrown: unknown;
    try {
      await failingPool(400, body).invoke("t");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(JudgeError);
    if (thrown instanceof JudgeError) {
      expect(thrown.isContextOverflow).toBe(true);
      expect(thrown.nPromptTokens).toBe(undefined);
      expect(thrown.nCtx).toBe(undefined);
    }
  });
});
