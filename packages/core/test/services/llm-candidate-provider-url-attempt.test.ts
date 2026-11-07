import { expect, test } from "bun:test";

import {
  attemptCandidatesInOrder,
  attemptLlmCandidates,
  buildChatCompletionsUrl,
  describeLlmCandidate,
  type ResolvedLlmCandidate,
  resolveLlmProvider,
} from "@src/services/llm-candidates.js";

test("resolveLlmProvider returns an explicit allowed provider without parsing the URL", () => {
  expect(resolveLlmProvider("not a url", "sakana")).toBe("sakana");
});

test("resolveLlmProvider throws for an explicit provider outside the allowlist", () => {
  expect(() => resolveLlmProvider("http://localhost:8080", "billed")).toThrow(
    "LLM provider 'billed' is not allowed",
  );
});

test("resolveLlmProvider falls through to host inference for an empty explicit provider", () => {
  expect(resolveLlmProvider("http://localhost:8080/v1", "")).toBe("local");
});

test("resolveLlmProvider resolves localhost to local", () => {
  expect(resolveLlmProvider("http://localhost:1234/v1")).toBe("local");
});

test("resolveLlmProvider resolves 127.0.0.1 to local", () => {
  expect(resolveLlmProvider("http://127.0.0.1:1234/v1")).toBe("local");
});

test("resolveLlmProvider resolves the IPv6 loopback host to local", () => {
  expect(resolveLlmProvider("http://[::1]:1234/v1")).toBe("local");
});

test("resolveLlmProvider resolves a *.local mDNS host to local", () => {
  expect(resolveLlmProvider("http://studio.local:8080/v1")).toBe("local");
});

test("resolveLlmProvider resolves sakana.ai to sakana", () => {
  expect(resolveLlmProvider("https://sakana.ai/v1")).toBe("sakana");
});

test("resolveLlmProvider resolves a sakana.ai subdomain to sakana", () => {
  expect(resolveLlmProvider("https://api.sakana.ai/v1")).toBe("sakana");
});

test("resolveLlmProvider rejects a host that only ends in the letters sakana.ai", () => {
  expect(() => resolveLlmProvider("https://notsakana.ai/v1")).toThrow(
    "LLM provider is required for unrecognized host 'notsakana.ai'",
  );
});

test("resolveLlmProvider rejects a loopback name used as a subdomain prefix", () => {
  expect(() => resolveLlmProvider("https://localhost.example.com/v1")).toThrow(
    "unrecognized host 'localhost.example.com'",
  );
});

test("resolveLlmProvider throws the invalid-URL error for an invalid base URL with no explicit provider", () => {
  expect(() => resolveLlmProvider("not a url")).toThrow(
    "cannot resolve LLM provider from invalid base URL 'not a url'",
  );
});

test("buildChatCompletionsUrl appends only /chat/completions to a base ending in /v1", () => {
  expect(buildChatCompletionsUrl("http://h:1/v1")).toBe("http://h:1/v1/chat/completions");
});

test("buildChatCompletionsUrl appends /v1/chat/completions to a base without /v1", () => {
  expect(buildChatCompletionsUrl("http://h:1")).toBe("http://h:1/v1/chat/completions");
});

test("buildChatCompletionsUrl strips trailing slashes before the /v1 check", () => {
  expect(buildChatCompletionsUrl("http://h:1/v1///")).toBe("http://h:1/v1/chat/completions");
});

test("buildChatCompletionsUrl does not treat a path only starting with v1 as /v1", () => {
  expect(buildChatCompletionsUrl("http://h:1/api/v1beta")).toBe(
    "http://h:1/api/v1beta/v1/chat/completions",
  );
});

test("attemptCandidatesInOrder stops at the first success and returns earlier failures", async () => {
  const calls: string[] = [];
  const result = await attemptCandidatesInOrder(["a", "b", "c"], (candidate) => {
    calls.push(candidate);
    if (candidate === "a") return Promise.resolve({ ok: false, error: "e-a" } as const);
    if (candidate === "b") return Promise.resolve({ ok: true, value: "v-b" } as const);
    return Promise.resolve({ ok: true, value: "v-c" } as const);
  });

  expect(calls).toEqual(["a", "b"]);
  expect(result).toEqual({
    ok: true,
    value: "v-b",
    candidate: "b",
    failures: [{ candidate: "a", error: "e-a" }],
  });
});

test("attemptCandidatesInOrder reports every failure in order when every candidate fails", async () => {
  const calls: string[] = [];
  const result = await attemptCandidatesInOrder(["a", "b"], (candidate) => {
    calls.push(candidate);
    return Promise.resolve({ ok: false, error: `e-${candidate}` } as const);
  });

  expect(result).toEqual({
    ok: false,
    failures: [
      { candidate: "a", error: "e-a" },
      { candidate: "b", error: "e-b" },
    ],
  });
  expect(calls).toEqual(["a", "b"]);
});

test("attemptCandidatesInOrder returns ok:false with no failures for an empty candidate list", async () => {
  const calls: string[] = [];
  const result = await attemptCandidatesInOrder([] as string[], (candidate) => {
    calls.push(candidate);
    return Promise.resolve({ ok: true, value: "never" } as const);
  });

  expect(calls).toEqual([]);
  expect(result).toEqual({ ok: false, failures: [] });
});

test("attemptLlmCandidates returns the first successful candidate", async () => {
  const first: ResolvedLlmCandidate = {
    name: "seat-a",
    baseUrl: "http://localhost:8080/v1",
    model: "model-a",
    provider: "local",
    auth: { source: "none" },
    tier: "primary",
  };
  const second: ResolvedLlmCandidate = {
    name: "seat-b",
    baseUrl: "https://api.sakana.ai/v1",
    model: "model-b",
    provider: "sakana",
    auth: { source: "bearer", token: "tok" },
    tier: "fallback",
  };

  const result = await attemptLlmCandidates([first, second], (candidate) =>
    candidate.name === "seat-a"
      ? Promise.resolve({ ok: false, error: "down" })
      : Promise.resolve({ ok: true, value: 1 }),
  );

  expect(result).toEqual({
    ok: true,
    value: 1,
    candidate: second,
    failures: [{ candidate: first, error: "down" }],
  });
});

const tokenBearingCandidate = (): ResolvedLlmCandidate => ({
  name: "seat",
  baseUrl: "https://api.sakana.ai/v1",
  model: "m",
  provider: "sakana",
  auth: { source: "bearer", token: "tok-secret-123" },
  adapter: "openai-compat-http",
  options: { apiKey: "tok-secret-123" },
  tier: "fallback",
});

test("describeLlmCandidate projects only name, baseUrl, model, provider, authSource and tier", () => {
  expect(describeLlmCandidate(tokenBearingCandidate())).toEqual({
    name: "seat",
    baseUrl: "https://api.sakana.ai/v1",
    model: "m",
    provider: "sakana",
    authSource: "bearer",
    tier: "fallback",
  });
});

test("describeLlmCandidate does not carry the bearer token", () => {
  expect(JSON.stringify(describeLlmCandidate(tokenBearingCandidate()))).not.toContain(
    "tok-secret-123",
  );
});
