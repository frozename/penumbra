import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServeOptions, prepareConsoleServer, runConsole } from "@src/commands/console.js";

let storageRoot = "";
let distRoot = "";
let mockDaemon: ReturnType<typeof Bun.serve> | null = null;
let mockDaemonRequests: {
  method: string;
  path: string;
  authorization: string | null;
  cookie: string | null;
  operator: string | null;
}[] = [];

const TOKEN = "test-token-xyz";
let expectedDaemonToken = TOKEN;

const FIXTURE_HTML = `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none';">
    <title>console</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

function startMockDaemon(echoBody = "ok"): number {
  mockDaemonRequests = [];
  mockDaemon = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      mockDaemonRequests.push({
        method: req.method,
        path: url.pathname + url.search,
        authorization: req.headers.get("authorization"),
        cookie: req.headers.get("cookie"),
        operator: req.headers.get("x-penumbra-operator"),
      });
      if (req.headers.get("authorization") !== `Bearer ${expectedDaemonToken}`) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/handoffs" && url.searchParams.get("status") === "pending") {
        return new Response(JSON.stringify({ handoffs: [{ id: "h1" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/echo") {
        return new Response(echoBody, { status: 200 });
      }
      if (url.pathname === "/sse") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
            timer = setTimeout(() => {
              try {
                controller.enqueue(new TextEncoder().encode("data: 2\n\n"));
                controller.close();
              } catch {
                // the proxied response may already be cancelled by a client disconnect
              }
            }, 200);
          },
          cancel(): void {
            clearTimeout(timer);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return mockDaemon.port!;
}

beforeEach(() => {
  expectedDaemonToken = TOKEN;
  storageRoot = mkdtempSync(join(tmpdir(), "penumbra-console-cli-store-"));
  distRoot = mkdtempSync(join(tmpdir(), "penumbra-console-cli-dist-"));
  const daemonPort = startMockDaemon();
  writeFileSync(join(storageRoot, "port"), `${String(daemonPort)}\n`);
  writeFileSync(join(storageRoot, "token"), `${TOKEN}\n`);
  writeFileSync(join(distRoot, "index.html"), FIXTURE_HTML);
  writeFileSync(join(distRoot, "app.js"), "// hello world");
});

afterEach(() => {
  if (mockDaemon) {
    void mockDaemon.stop(true);
    mockDaemon = null;
  }
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  if (distRoot) rmSync(distRoot, { recursive: true, force: true });
});

function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = /penumbra_session=([^;]+)/.exec(setCookie);
  return m ? m[1]! : null;
}

test("prepareConsoleServer: index.html sets HttpOnly session cookie + security headers + no-store", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/`);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain("penumbra_session=");
    expect(setCookie!).toContain("HttpOnly");
    expect(setCookie!).toContain("SameSite=Strict");
    expect(setCookie!).toContain("Path=/");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("<title>console</title>");
    expect(html).toContain("connect-src 'self'");
    expect(html).not.toContain("http://127.0.0.1:*");
    // Bearer token must NOT appear in served HTML
    expect(html).not.toContain(TOKEN);
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: served index.html contains no token string anywhere", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/`);
    const html = await res.text();
    expect(html.indexOf(TOKEN)).toBe(-1);
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: /api request without cookie is rejected with 401", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/api/handoffs?status=pending`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_session");
    // Mock daemon must not have seen the request
    expect(mockDaemonRequests.length).toBe(0);
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: /api with valid cookie is proxied to daemon with bearer token", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get("set-cookie"));
    expect(cookieValue).not.toBeNull();
    expect(cookieValue).toBe(prepared.sessionNonce);

    const apiRes = await fetch(`${prepared.url}/api/handoffs?status=pending`, {
      headers: { Cookie: `penumbra_session=${cookieValue ?? ""}` },
    });
    expect(apiRes.status).toBe(200);
    const payload = (await apiRes.json()) as { handoffs: { id: string }[] };
    expect(payload.handoffs[0]!.id).toBe("h1");

    expect(mockDaemonRequests.length).toBe(1);
    const recorded = mockDaemonRequests[0]!;
    expect(recorded.method).toBe("GET");
    expect(recorded.path).toBe("/handoffs?status=pending");
    expect(recorded.authorization).toBe(`Bearer ${TOKEN}`);
    // Cookie should NOT have been forwarded to the daemon
    expect(recorded.cookie).toBeNull();
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: mutating /api requests require sec-fetch-site same-origin", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get("set-cookie"));
    const apiRes = await fetch(`${prepared.url}/api/echo`, {
      method: "POST",
      headers: {
        Cookie: `penumbra_session=${cookieValue ?? ""}`,
      },
      body: "x",
    });
    expect(apiRes.status).toBe(403);
    const payload = (await apiRes.json()) as { error?: string };
    expect(payload.error).toBe("cross_site_request_forbidden");
    expect(mockDaemonRequests.length).toBe(0);
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: mutating /api requests require matching Origin", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get("set-cookie"));

    const missingOrigin = await fetch(`${prepared.url}/api/echo`, {
      method: "POST",
      headers: {
        Cookie: `penumbra_session=${cookieValue ?? ""}`,
        "Sec-Fetch-Site": "same-origin",
      },
      body: "x",
    });
    expect(missingOrigin.status).toBe(403);
    expect(((await missingOrigin.json()) as { error?: string }).error).toBe(
      "cross_site_request_forbidden",
    );

    const wrongOrigin = await fetch(`${prepared.url}/api/echo`, {
      method: "POST",
      headers: {
        Cookie: `penumbra_session=${cookieValue ?? ""}`,
        "Sec-Fetch-Site": "same-origin",
        Origin: "http://127.0.0.1:1",
      },
      body: "x",
    });
    expect(wrongOrigin.status).toBe(403);
    expect(((await wrongOrigin.json()) as { error?: string }).error).toBe(
      "cross_site_request_forbidden",
    );
    expect(mockDaemonRequests.length).toBe(0);
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: mutating /api requests with same-origin headers are allowed", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get("set-cookie"));
    const apiRes = await fetch(`${prepared.url}/api/echo`, {
      method: "POST",
      headers: {
        Cookie: `penumbra_session=${cookieValue ?? ""}`,
        "Sec-Fetch-Site": "same-origin",
        Origin: prepared.url,
      },
      body: "x",
    });
    expect(apiRes.status).toBe(200);
    expect(await apiRes.text()).toBe("ok");
    expect(mockDaemonRequests.length).toBe(1);
    expect(mockDaemonRequests[0]!.method).toBe("POST");
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: /api response strips upstream Set-Cookie + Authorization, keeps security headers", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get("set-cookie"));
    const apiRes = await fetch(`${prepared.url}/api/handoffs?status=pending`, {
      headers: { Cookie: `penumbra_session=${cookieValue ?? ""}` },
    });
    expect(apiRes.headers.get("x-frame-options")).toBe("DENY");
    expect(apiRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(apiRes.headers.get("set-cookie")).toBeNull();
    expect(apiRes.headers.get("vary")).toBe("Origin, Sec-Fetch-Site");
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: refreshes daemon bootstrap after connectivity failure and retries once", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get("set-cookie"));
    const first = await fetch(`${prepared.url}/api/echo`, {
      headers: { Cookie: `penumbra_session=${cookieValue ?? ""}` },
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("ok");

    void mockDaemon?.stop(true);
    mockDaemon = null;
    const newPort = startMockDaemon("ok2");
    writeFileSync(join(storageRoot, "port"), `${String(newPort)}\n`);

    const second = await fetch(`${prepared.url}/api/echo`, {
      headers: { Cookie: `penumbra_session=${cookieValue ?? ""}` },
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("ok2");
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: refreshes daemon bootstrap after upstream 401 and retries once", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get("set-cookie"));
    const first = await fetch(`${prepared.url}/api/echo`, {
      headers: { Cookie: `penumbra_session=${cookieValue ?? ""}` },
    });
    expect(first.status).toBe(200);

    expectedDaemonToken = "rotated-token";
    writeFileSync(join(storageRoot, "token"), `${expectedDaemonToken}\n`);

    const second = await fetch(`${prepared.url}/api/echo`, {
      headers: { Cookie: `penumbra_session=${cookieValue ?? ""}` },
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("ok");
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: serves static assets and 404 for unknown", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const ok = await fetch(`${prepared.url}/app.js`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("// hello world");
    expect(ok.headers.get("x-frame-options")).toBe("DENY");

    const missing = await fetch(`${prepared.url}/does-not-exist.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-frame-options")).toBe("DENY");
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: rejects path traversal with 403 or 404", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/../../../etc/passwd.conf`);
    expect([403, 404]).toContain(res.status);
  } finally {
    await prepared.stop();
  }
});

test("a text/event-stream upstream writing frame 1, then frame 2 after 200 ms: the client reads frame 1 before frame 2 is written (piped, not awaited)", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get("set-cookie"));
    const res = await fetch(`${prepared.url}/api/sse`, {
      headers: { Cookie: `penumbra_session=${cookieValue ?? ""}` },
    });
    expect(res.status).toBe(200);
    const reader: ReadableStreamDefaultReader<Uint8Array> = res.body!.getReader();
    try {
      const first = await Promise.race([
        reader.read(),
        Bun.sleep(100).then((): never => {
          throw new Error("first SSE frame was buffered, not piped");
        }),
      ]);
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain("data: 1");
      expect(text).not.toContain("data: 2");
    } finally {
      await reader.cancel();
    }
  } finally {
    await prepared.stop();
  }
});

test("buildServeOptions().idleTimeout === 255", () => {
  const options = buildServeOptions({
    port: 0,
    distNorm: distRoot,
    daemon: {
      port: () => 1,
      token: () => "t",
      refresh: () => false,
    },
    sessionNonce: "n",
  });
  expect(options.idleTimeout).toBe(255);
});

test("closing the client stream aborts the upstream fetch signal", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  const realFetch = globalThis.fetch;
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => {
    if (i) {
      seen.push({ url: u instanceof Request ? u.url : String(u), init: i });
    }
    return realFetch(u, i);
  }) as typeof fetch;
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get("set-cookie"));
    const daemonBaseUrl = `http://127.0.0.1:${String(mockDaemon!.port)}`;
    const controller = new AbortController();
    const res = await fetch(`${prepared.url}/api/sse`, {
      headers: { Cookie: `penumbra_session=${cookieValue ?? ""}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const upstream = seen.find((c) => c.url.startsWith(daemonBaseUrl));
    expect(upstream).not.toBeUndefined();
    expect(upstream!.init.signal instanceof AbortSignal).toBe(true);
    controller.abort();
    await Promise.resolve();
    const deadline = Date.now() + 2000;
    while (upstream!.init.signal?.aborted !== true && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(upstream!.init.signal?.aborted).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    // An aborted piped stream pins the launcher request in Bun's in-flight
    // bookkeeping past server.stop(); the listening socket still closes, so
    // racing the stop is enough teardown for this test.
    await Promise.race([prepared.stop(), Bun.sleep(500)]);
  }
});

test("an inbound X-Penumbra-Operator header is dropped", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const indexRes = await fetch(`${prepared.url}/`);
    const cookieValue = extractSessionCookie(indexRes.headers.get("set-cookie"));
    const apiRes = await fetch(`${prepared.url}/api/handoffs?status=pending`, {
      headers: {
        Cookie: `penumbra_session=${cookieValue ?? ""}`,
        "X-Penumbra-Operator": "spoof",
      },
    });
    expect(apiRes.status).toBe(200);
    expect(mockDaemonRequests.length).toBe(1);
    expect(mockDaemonRequests[0]!.operator).toBeNull();
  } finally {
    await prepared.stop();
  }
});

test("GET /handoffs/abc (no extension) serves index.html with the session cookie", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/handoffs/abc`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("set-cookie")).toContain("penumbra_session");
    const html = await res.text();
    expect(html).toContain("<title>console</title>");
    expect(html).not.toContain("http://127.0.0.1:*");
  } finally {
    await prepared.stop();
  }
});

test("GET /assets/missing.js still answers 404", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/assets/missing.js`);
    expect(res.status).toBe(404);
  } finally {
    await prepared.stop();
  }
});

test("GET /../../../etc/passwd (URL-normalized, extension-less) serves the SPA index, not the traversal target", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${prepared.url}/../../../etc/passwd`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain("<title>console</title>");
    expect(html).not.toContain("root:");
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: binds 127.0.0.1 only", async () => {
  const prepared = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    expect(prepared.url.startsWith("http://127.0.0.1:")).toBe(true);
  } finally {
    await prepared.stop();
  }
});

test("prepareConsoleServer: each launch generates a fresh session nonce", async () => {
  const a = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  const b = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    expect(a.sessionNonce).not.toBe(b.sessionNonce);
    expect(a.sessionNonce.length).toBe(64);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("prepareConsoleServer: cookie from one launch is rejected by another launch", async () => {
  const a = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  const b = await prepareConsoleServer({ port: 0, storageRoot, distPath: distRoot });
  try {
    const res = await fetch(`${b.url}/api/handoffs?status=pending`, {
      headers: { Cookie: `penumbra_session=${a.sessionNonce}` },
    });
    expect(res.status).toBe(401);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("runConsole: missing dist directory → exitCode 1 with build hint", async () => {
  const stderr: string[] = [];
  const result = await runConsole({
    port: 0,
    noOpen: true,
    storageRoot,
    distPath: "/nonexistent-penumbra-dist-xyz",
    _testReturnImmediately: true,
    _stderr: (s) => stderr.push(s),
  });
  expect(result.exitCode).toBe(1);
  const errOut = stderr.join("\n");
  expect(errOut).toMatch(/Console assets not found/);
  expect(errOut).toMatch(/bun .* packages\/console run build/);
});

test("runConsole: missing index.html in dist dir → exitCode 1", async () => {
  rmSync(join(distRoot, "index.html"));
  const stderr: string[] = [];
  const result = await runConsole({
    port: 0,
    noOpen: true,
    storageRoot,
    distPath: distRoot,
    _testReturnImmediately: true,
    _stderr: (s) => stderr.push(s),
  });
  expect(result.exitCode).toBe(1);
  expect(stderr.join("\n")).toMatch(/Console assets not found/);
});

test("runConsole: missing token file → exitCode 1", async () => {
  rmSync(join(storageRoot, "token"));
  const stderr: string[] = [];
  const result = await runConsole({
    port: 0,
    noOpen: true,
    storageRoot,
    distPath: distRoot,
    _testReturnImmediately: true,
    _stderr: (s) => stderr.push(s),
  });
  expect(result.exitCode).toBe(1);
  expect(stderr.join("\n")).toMatch(/no token found/);
});

test("runConsole: missing port file → exitCode 1", async () => {
  rmSync(join(storageRoot, "port"));
  const stderr: string[] = [];
  const result = await runConsole({
    port: 0,
    noOpen: true,
    storageRoot,
    distPath: distRoot,
    _testReturnImmediately: true,
    _stderr: (s) => stderr.push(s),
  });
  expect(result.exitCode).toBe(1);
  expect(stderr.join("\n")).toMatch(/no daemon port/);
});

test("runConsole: returns immediately with exitCode 0 in test mode", async () => {
  const stdout: string[] = [];
  const result = await runConsole({
    port: 0,
    noOpen: true,
    storageRoot,
    distPath: distRoot,
    _testReturnImmediately: true,
    _stdout: (s) => stdout.push(s),
  });
  expect(result.exitCode).toBe(0);
  expect(stdout.join("\n")).toMatch(/Operator console: http:\/\/127\.0\.0\.1:\d+/);
});
