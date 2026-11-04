import type { LlmServingCandidate } from "@penumbra/core";

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  invokeRewriter,
  noEligibleCandidateMessage,
  type RewriteInvokeResult,
} from "@src/dreaming/rewrite-invoke.js";
import type { LlmInvokeInput, LlmInvokeResult } from "@src/services/llm-invoke.js";

const schema = z.object({ q: z.string() });
type Schema = typeof schema;
type Invoker = (input: LlmInvokeInput<Schema>) => Promise<LlmInvokeResult<Schema>>;
type Failure = Exclude<RewriteInvokeResult<Schema>, { ok: true }>;

function baseInput(overrides: Partial<LlmInvokeInput<Schema>> = {}): LlmInvokeInput<Schema> {
  return {
    baseUrl: "http://127.0.0.1:7944/v1",
    model: "rewriter-a",
    messages: [{ role: "user", content: "q" }],
    schema,
    ...overrides,
  };
}

function succeeded(): LlmInvokeResult<Schema> {
  return {
    ok: true,
    value: { q: "x" },
    raw: "{}",
    candidate: {
      name: "rewriter-a",
      baseUrl: "http://127.0.0.1:7944/v1",
      model: "rewriter-a",
      provider: "local",
      authSource: "none",
      tier: "primary",
    },
  };
}

function rejecting(err: unknown): Invoker {
  return () =>
    Promise.resolve().then(() => {
      throw err;
    });
}

function asFailure(result: RewriteInvokeResult<Schema>): Failure {
  if (result.ok) throw new Error("expected a failure result");
  return result;
}

async function candidateFor(
  overrides: Partial<LlmInvokeInput<Schema>> = {},
): Promise<LlmServingCandidate | undefined> {
  const result = await invokeRewriter(
    rejecting(new Error("all seats excluded")),
    baseInput(overrides),
  );
  return asFailure(result).candidate;
}

describe("invokeRewriter", () => {
  test("passes a resolved success through by identity", async () => {
    const value = succeeded();
    const invoke: Invoker = () => Promise.resolve(value);

    const result = await invokeRewriter(invoke, baseInput());

    expect(result).toBe(value);
  });

  test("passes a resolved failure through unwrapped", async () => {
    const value: LlmInvokeResult<Schema> = {
      ok: false,
      reason: "http_error",
      status: 503,
      failureMessage: "down",
    };
    const invoke: Invoker = () => Promise.resolve(value);

    const result = await invokeRewriter(invoke, baseInput());

    expect(result).toBe(value);
    expect(asFailure(result).reason).toBe("http_error");
  });

  test("forwards the caller's input object by identity", async () => {
    let seen: LlmInvokeInput<Schema> | undefined;
    const invoke: Invoker = (input) => {
      seen = input;
      return Promise.resolve(succeeded());
    };
    const input = baseInput();

    await invokeRewriter(invoke, input);

    expect(seen).toBe(input);
  });

  test("wraps an Error rejection as no_eligible_candidate with the error message", async () => {
    const err = new Error("every seat excluded by routing bias");

    const result = await invokeRewriter(rejecting(err), baseInput());

    expect(result).toMatchObject({
      ok: false,
      reason: "no_eligible_candidate",
      failureMessage: err.message,
    });
    expect(asFailure(result).failures).toBeUndefined();
  });

  test("stringifies a non-Error rejection into failureMessage", async () => {
    const stringResult = asFailure(await invokeRewriter(rejecting("seat gone"), baseInput()));
    expect(stringResult.failureMessage).toBe("seat gone");

    const numberResult = asFailure(await invokeRewriter(rejecting(42), baseInput()));
    expect(numberResult.failureMessage).toBe("42");
  });

  test("candidate.name uses input.candidateName when set", async () => {
    const candidate = await candidateFor({ candidateName: "local-rewriter" });

    expect(candidate?.name).toBe("local-rewriter");
  });

  test("candidate.name falls back to input.model when candidateName is absent", async () => {
    const candidate = await candidateFor();

    expect(candidate?.name).toBe("rewriter-a");
  });

  test("candidate copies baseUrl and model from input and pins tier to primary", async () => {
    const candidate = await candidateFor({
      baseUrl: "http://127.0.0.1:8111/v1",
      model: "rewriter-b",
    });

    expect(candidate?.baseUrl).toBe("http://127.0.0.1:8111/v1");
    expect(candidate?.model).toBe("rewriter-b");
    expect(candidate?.tier).toBe("primary");
  });

  test("an explicit provider wins even outside the allowlist", async () => {
    const candidate = await candidateFor({ provider: "anthropic" });

    expect(candidate?.provider).toBe("anthropic");
  });

  test("provider is inferred as local from a loopback baseUrl", async () => {
    const loopback = await candidateFor();
    expect(loopback?.provider).toBe("local");

    const localhost = await candidateFor({ baseUrl: "http://localhost:7944/v1" });
    expect(localhost?.provider).toBe("local");
  });

  test("provider is inferred as sakana from an api.sakana.ai baseUrl", async () => {
    const candidate = await candidateFor({ baseUrl: "https://api.sakana.ai/v1" });

    expect(candidate?.provider).toBe("sakana");
  });

  test("provider is unknown for an unrecognized host with no provider", async () => {
    const candidate = await candidateFor({ baseUrl: "https://example.invalid/v1" });

    expect(candidate?.provider).toBe("unknown");
  });

  test("authSource uses input.auth.source when given", async () => {
    const candidate = await candidateFor({ auth: { source: "bearer", token: "t" } });

    expect(candidate?.authSource).toBe("bearer");
  });

  test("authSource is none when auth is absent", async () => {
    const candidate = await candidateFor();

    expect(candidate?.authSource).toBe("none");
  });
});

describe("noEligibleCandidateMessage", () => {
  test("returns failureMessage when reason is no_eligible_candidate", () => {
    const message = noEligibleCandidateMessage({
      reason: "no_eligible_candidate",
      failureMessage: "every seat excluded by an active bias",
    });

    expect(message).toBe("every seat excluded by an active bias");
  });

  test("returns undefined for other reasons even with a non-empty failureMessage", () => {
    expect(
      noEligibleCandidateMessage({ reason: "http_error", failureMessage: "down" }),
    ).toBeUndefined();
    expect(
      noEligibleCandidateMessage({ reason: "timeout", failureMessage: "too slow" }),
    ).toBeUndefined();
  });
});
