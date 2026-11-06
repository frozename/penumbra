import { afterEach, expect, mock, test } from "bun:test";

import { DaemonClient } from "@src/daemon-client.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchHandler = (input: FetchInput, init?: FetchInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: FetchHandler): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}

function readUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function newClient(): DaemonClient {
  return new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
}

test("memoryEfficacyJobs GETs /memory/efficacy/jobs with no query for empty request", async () => {
  const received: { url: string; method: string | undefined }[] = [];
  mockFetch(
    mock((input: FetchInput, init?: FetchInit) => {
      received.push({ url: readUrl(input), method: init?.method });
      return Promise.resolve(Response.json({}));
    }),
  );
  await newClient().memoryEfficacyJobs({});
  expect(received).toHaveLength(1);
  expect(received[0]?.url).toBe("http://localhost:1234/memory/efficacy/jobs");
  expect(received[0]?.url).not.toContain("?");
  expect(received[0]?.method).toBeUndefined();
});

test("memoryEfficacyJobs sends limit as a query param", async () => {
  const seen: string[] = [];
  mockFetch(
    mock((input: FetchInput) => {
      seen.push(readUrl(input));
      return Promise.resolve(Response.json({}));
    }),
  );
  await newClient().memoryEfficacyJobs({ limit: 5 });
  expect(seen[0]).toBe("http://localhost:1234/memory/efficacy/jobs?limit=5");
});

test("memoryEfficacyJobs sends status as a query param", async () => {
  const seen: string[] = [];
  mockFetch(
    mock((input: FetchInput) => {
      seen.push(readUrl(input));
      return Promise.resolve(Response.json({}));
    }),
  );
  await newClient().memoryEfficacyJobs({ status: "failed" });
  expect(seen[0]).toBe("http://localhost:1234/memory/efficacy/jobs?status=failed");
});

test("memoryEfficacyJobs orders query params limit then status", async () => {
  const seen: string[] = [];
  mockFetch(
    mock((input: FetchInput) => {
      seen.push(readUrl(input));
      return Promise.resolve(Response.json({}));
    }),
  );
  await newClient().memoryEfficacyJobs({ limit: 5, status: "failed" });
  expect(seen[0]).toBe("http://localhost:1234/memory/efficacy/jobs?limit=5&status=failed");
});

test("memoryEfficacyJobs omits limit=0 (truthiness check)", async () => {
  const seen: string[] = [];
  mockFetch(
    mock((input: FetchInput) => {
      seen.push(readUrl(input));
      return Promise.resolve(Response.json({}));
    }),
  );
  await newClient().memoryEfficacyJobs({ limit: 0 });
  expect(seen[0]).toBe("http://localhost:1234/memory/efficacy/jobs");
  expect(seen[0]).not.toContain("?");
});

test("memoryEfficacyJobs omits empty-string status", async () => {
  const seen: string[] = [];
  mockFetch(
    mock((input: FetchInput) => {
      seen.push(readUrl(input));
      return Promise.resolve(Response.json({}));
    }),
  );
  await newClient().memoryEfficacyJobs({ status: "" });
  expect(seen[0]).toBe("http://localhost:1234/memory/efficacy/jobs");
  expect(seen[0]).not.toContain("?");
});

test("memoryEfficacyJobStatus GETs the URL-encoded job path", async () => {
  const seen: string[] = [];
  mockFetch(
    mock((input: FetchInput) => {
      seen.push(readUrl(input));
      return Promise.resolve(Response.json({}));
    }),
  );
  await newClient().memoryEfficacyJobStatus({ job_id: "a/b c" });
  expect(seen[0]).toBe("http://localhost:1234/memory/efficacy/job/a%2Fb%20c");
});

test("memoryEfficacyRecent POSTs to /memory/efficacy/recent with JSON body", async () => {
  const received: { url: string; method: string | undefined; body: unknown }[] = [];
  mockFetch(
    mock((input: FetchInput, init?: FetchInit) => {
      const body = init?.body;
      if (typeof body !== "string") {
        throw new Error("expected string body in test fetch mock");
      }
      received.push({ url: readUrl(input), method: init?.method, body: JSON.parse(body) });
      return Promise.resolve(Response.json({}));
    }),
  );
  await newClient().memoryEfficacyRecent({ limit: 3 });
  expect(received).toHaveLength(1);
  expect(received[0]?.url).toBe("http://localhost:1234/memory/efficacy/recent");
  expect(received[0]?.method).toBe("POST");
  expect(received[0]?.body).toEqual({ limit: 3 });
});
