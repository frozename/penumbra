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

function recordUrls(seen: string[]): FetchHandler {
  return mock((input: FetchInput) => {
    seen.push(readUrl(input));
    return Promise.resolve(Response.json({}));
  });
}

function newClient(): DaemonClient {
  return new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
}

test("qualityStatus sends no query string for an empty request", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().qualityStatus({});
  expect(seen[0]).toBe("http://localhost:1234/quality/status");
});

test("qualityStatus sends window_hours=0 (undefined check, not truthiness)", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().qualityStatus({ window_hours: 0 });
  expect(seen[0]).toBe("http://localhost:1234/quality/status?window_hours=0");
});

test("qualityStatus sends min_samples=0 (undefined check, not truthiness)", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().qualityStatus({ min_samples: 0 });
  expect(seen[0]).toBe("http://localhost:1234/quality/status?min_samples=0");
});

test("qualityStatus form-encodes workflow_name", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().qualityStatus({ workflow_name: "a b&c" });
  expect(seen[0]).toBe("http://localhost:1234/quality/status?workflow_name=a+b%26c");
});

test("qualityStatus orders query params window_hours, min_samples, workflow_name", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().qualityStatus({ window_hours: 48, min_samples: 3, workflow_name: "w" });
  expect(seen[0]).toBe(
    "http://localhost:1234/quality/status?window_hours=48&min_samples=3&workflow_name=w",
  );
});

test("memoryVerificationEvents path-encodes memory_id and sends no query without limit", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().memoryVerificationEvents({ memory_id: "a/b c" });
  expect(seen[0]).toBe("http://localhost:1234/memory/a%2Fb%20c/verification_events");
});

test("memoryVerificationEvents sends limit=0 (undefined check, not truthiness)", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().memoryVerificationEvents({ memory_id: "m1", limit: 0 });
  expect(seen[0]).toBe("http://localhost:1234/memory/m1/verification_events?limit=0");
});

test("sessionNoteDrafts sends no query string when called with no argument", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().sessionNoteDrafts();
  expect(seen[0]).toBe("http://localhost:1234/session-notes/drafts");
});

test("sessionNoteDrafts orders query params status, limit", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().sessionNoteDrafts({ status: "approved", limit: 7 });
  expect(seen[0]).toBe("http://localhost:1234/session-notes/drafts?status=approved&limit=7");
});
