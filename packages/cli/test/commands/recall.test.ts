import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRecall } from "@src/commands/recall.js";

import { expectAsyncThrow, parseJson, urlToString } from "./_helpers.js";

// Bun's `typeof fetch` carries a static `preconnect` that bare mock functions
// lack; Object.assign closes the structural gap without laundering the type.
function asFetchMock(
  impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: (): void => undefined });
}

interface Recorded {
  url: string;
  init?: RequestInit;
}

let storageRoot = "";
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  storageRoot = mkdtempSync(join(tmpdir(), "penumbra-cli-recall-"));
  writeFileSync(join(storageRoot, "port"), "4242\n");
  writeFileSync(join(storageRoot, "token"), "tok\n");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
});

function installFetchMock(recorded: Recorded[], response: () => Response): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = asFetchMock((url, init) => {
    counter.calls += 1;
    recorded.push({ url: urlToString(url), init });
    return Promise.resolve(response());
  });
  return counter;
}

const HIT_FIXTURE = [
  {
    id: "hit-1",
    tier: "t2",
    score: 0.9,
    title: "note",
    body: "body text",
    project_id: "alpha",
    source_session_ids: ["s-1"],
    created_at: "2026-01-01T00:00:00Z",
  },
];

test("runRecall: missing port file rejects with start hint and never calls fetch", async () => {
  rmSync(join(storageRoot, "port"));
  const recorded: Recorded[] = [];
  const counter = installFetchMock(recorded, () => new Response("{}", { status: 200 }));
  await expectAsyncThrow(
    runRecall({ storageRoot, query: "q", project: null, limit: 5 }),
    /missing.*Run 'penumbra start' first/,
  );
  expect(counter.calls).toBe(0);
});

test("runRecall: missing token file rejects with start hint and never calls fetch", async () => {
  rmSync(join(storageRoot, "token"));
  const recorded: Recorded[] = [];
  const counter = installFetchMock(recorded, () => new Response("{}", { status: 200 }));
  await expectAsyncThrow(
    runRecall({ storageRoot, query: "q", project: null, limit: 5 }),
    /missing.*Run 'penumbra start' first/,
  );
  expect(counter.calls).toBe(0);
});

test("runRecall: URL is exactly http://127.0.0.1:4242/recall with trimmed port and POST method", async () => {
  const recorded: Recorded[] = [];
  installFetchMock(recorded, () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  await runRecall({ storageRoot, query: "q", project: null, limit: 5 });
  expect(recorded.length).toBe(1);
  const req = recorded[0];
  if (!req) throw new Error("expected one recorded request");
  expect(req.url).toBe("http://127.0.0.1:4242/recall");
  expect(req.init?.method).toBe("POST");
});

test("runRecall: headers carry bearer token and JSON content-type", async () => {
  const recorded: Recorded[] = [];
  installFetchMock(recorded, () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  await runRecall({ storageRoot, query: "q", project: null, limit: 5 });
  const req = recorded[0];
  if (!req) throw new Error("expected one recorded request");
  const headers = new Headers(req.init?.headers);
  expect(headers.get("authorization")).toBe("Bearer tok");
  expect(headers.get("content-type")).toBe("application/json");
});

test("runRecall: JSON body forwards every opts field plus min_score 0", async () => {
  const recorded: Recorded[] = [];
  installFetchMock(recorded, () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  await runRecall({
    storageRoot,
    query: "how do sweeps work",
    project: "alpha",
    limit: 12,
    session_id: "s-7",
    event_types: ["tool_call", "session_end"],
    file_path: "src/foo.ts",
    include_raw: true,
  });
  const body = recorded[0]?.init?.body;
  if (typeof body !== "string") throw new Error("expected a string request body");
  expect(parseJson(body)).toEqual({
    query: "how do sweeps work",
    project_id: "alpha",
    limit: 12,
    min_score: 0,
    session_id: "s-7",
    event_types: ["tool_call", "session_end"],
    file_path: "src/foo.ts",
    include_raw: true,
  });
});

test("runRecall: undefined optional fields are omitted from the JSON body", async () => {
  const recorded: Recorded[] = [];
  installFetchMock(recorded, () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  await runRecall({ storageRoot, query: "q", project: "alpha", limit: 3 });
  const body = recorded[0]?.init?.body;
  if (typeof body !== "string") throw new Error("expected a string request body");
  expect(parseJson(body)).toEqual({
    query: "q",
    project_id: "alpha",
    limit: 3,
    min_score: 0,
  });
});

test("runRecall: null project is sent as project_id null, not omitted", async () => {
  const recorded: Recorded[] = [];
  installFetchMock(recorded, () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  await runRecall({ storageRoot, query: "q", project: null, limit: 3 });
  const raw = recorded[0]?.init?.body;
  if (typeof raw !== "string") throw new Error("expected a string request body");
  const body = parseJson(raw);
  expect(typeof body === "object" && body !== null && "project_id" in body).toBe(true);
  expect(body).toMatchObject({ project_id: null });
});

test("runRecall: non-ok response rejects with the daemon HTTP status", async () => {
  installFetchMock([], () => new Response("unavailable", { status: 503 }));
  await expectAsyncThrow(
    runRecall({ storageRoot, query: "q", project: null, limit: 5 }),
    "daemon /recall returned HTTP 503",
  );
});

test("runRecall: on success returns body.results as-is", async () => {
  installFetchMock(
    [],
    () => new Response(JSON.stringify({ results: HIT_FIXTURE }), { status: 200 }),
  );
  const results = await runRecall({ storageRoot, query: "q", project: null, limit: 5 });
  expect(results).toEqual(HIT_FIXTURE);
});
