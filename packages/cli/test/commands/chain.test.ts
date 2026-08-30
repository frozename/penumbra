import { runChainSendMessage } from "@src/commands/chain.js";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectAsyncThrow, urlToString } from "./_helpers.js";

let storageRoot = "";

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "penumbra-chain-cli-"));
  writeFileSync(join(storageRoot, "port"), "4242\n");
  writeFileSync(join(storageRoot, "token"), "tok\n");
});

afterEach(() => {
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
});

test("chain send-message: success path POSTs to /chains/<id>/messages with bearer token and prints ok", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchMock: typeof fetch = (url, init) => {
    requests.push({ url: urlToString(url), init });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  };
  const lines: string[] = [];
  await runChainSendMessage({
    handoff_id: "h-abc123",
    content: "hello world",
    storageRoot,
    print: (line) => lines.push(line),
    fetch: fetchMock,
  });
  expect(requests.length).toBe(1);
  const [req] = requests;
  expect(req!.url).toBe("http://127.0.0.1:4242/chains/h-abc123/messages");
  expect(req!.init?.method).toBe("POST");
  const headers = req!.init?.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer tok");
  expect(headers["content-type"]).toBe("application/json");
  expect(req!.init?.body).toBe(JSON.stringify({ content: "hello world" }));
  expect(lines).toEqual(["ok"]);
});

test('chain send-message: 404 surfaces "no live session for handoff"', async () => {
  const fetchMock: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ error: { code: "not_found", message: "handoff h-missing not found" } }),
        { status: 404 },
      ),
    );
  await expectAsyncThrow(
    runChainSendMessage({
      handoff_id: "h-missing",
      content: "ping",
      storageRoot,
      fetch: fetchMock,
    }),
    /no live session for handoff h-missing/,
  );
});

test("chain send-message: encodes handoff id segment", async () => {
  const requests: { url: string }[] = [];
  const fetchMock: typeof fetch = (url) => {
    requests.push({ url: urlToString(url) });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  };
  await runChainSendMessage({
    handoff_id: "h with/slash",
    content: "x",
    storageRoot,
    print: () => {
      /* discard */
    },
    fetch: fetchMock,
  });
  expect(requests[0]!.url).toBe("http://127.0.0.1:4242/chains/h%20with%2Fslash/messages");
});

test("chain send-message: 500 throws with HTTP status", async () => {
  const fetchMock: typeof fetch = () => Promise.resolve(new Response("boom", { status: 500 }));
  await expectAsyncThrow(
    runChainSendMessage({
      handoff_id: "h-x",
      content: "y",
      storageRoot,
      fetch: fetchMock,
    }),
    /HTTP 500/,
  );
});
