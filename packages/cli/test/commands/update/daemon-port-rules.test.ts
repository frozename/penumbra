import { describe, expect, test } from "bun:test";

import { createDaemonPort, createLogReader } from "@src/commands/update/daemon.js";
import type {
  Clock,
  Exec,
  ExecResult,
  FsPort,
  Http,
  LogCursor,
  LogSource,
} from "@src/commands/update/types.js";

function memFs(files: Record<string, string>): FsPort {
  return {
    readText: (path) => Promise.resolve(files[path] ?? null),
    appendText: () => Promise.resolve(),
    size: (path) => Promise.resolve(files[path]?.length ?? null),
    readFrom: (path, offset) => Promise.resolve((files[path] ?? "").slice(offset)),
    realpath: (path) => Promise.resolve(path),
  };
}

function recordingHttp(respond: () => Promise<{ status: number; text: string }>): {
  http: Http;
  urls: string[];
} {
  const urls: string[] = [];
  const http: Http = (url) => {
    urls.push(url);
    return respond();
  };
  return { http, urls };
}

function recordingExec(result: Partial<ExecResult>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (argv) => {
    calls.push([...argv]);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...result });
  };
  return { exec, calls };
}

function clock(now: number): Clock {
  return { now: () => now, sleep: () => Promise.resolve() };
}

const JOURNAL: LogSource = { kind: "journal", unit: "penumbra-daemon.service" };
const NONE: LogSource = { kind: "none", reason: "r" };

describe("createDaemonPort health", () => {
  const okHttp = (): { http: Http; urls: string[] } =>
    recordingHttp(() => Promise.resolve({ status: 200, text: '{"status":"ok"}' }));

  test("a port file of 0 is rejected without an HTTP call", async () => {
    const { http, urls } = okHttp();
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "0" }), http);
    expect(await daemon.health()).toEqual({
      ok: false,
      port: null,
      detail: "no valid port in /s/port",
    });
    expect(urls).toEqual([]);
  });

  test("a port file above 65535 is rejected without an HTTP call", async () => {
    const { http, urls } = okHttp();
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "65536" }), http);
    expect(await daemon.health()).toEqual({
      ok: false,
      port: null,
      detail: "no valid port in /s/port",
    });
    expect(urls).toEqual([]);
  });

  test("a non-integer port file is rejected without an HTTP call", async () => {
    const { http, urls } = okHttp();
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "1.5" }), http);
    expect(await daemon.health()).toEqual({
      ok: false,
      port: null,
      detail: "no valid port in /s/port",
    });
    expect(urls).toEqual([]);
  });

  test("port 65535 is accepted", async () => {
    const { http, urls } = okHttp();
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "65535" }), http);
    expect(await daemon.health()).toEqual({ ok: true, port: 65535, detail: "ok" });
    expect(urls).toEqual(["http://127.0.0.1:65535/health"]);
  });

  test("HTTP 200 whose body status is not ok is unhealthy", async () => {
    const { http } = recordingHttp(() =>
      Promise.resolve({ status: 200, text: '{"status":"degraded"}' }),
    );
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "1234" }), http);
    expect(await daemon.health()).toEqual({
      ok: false,
      port: 1234,
      detail: "GET /health returned HTTP 200",
    });
  });

  test("a non-200 status is unhealthy even when the body says ok", async () => {
    const { http } = recordingHttp(() => Promise.resolve({ status: 503, text: '{"status":"ok"}' }));
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "1234" }), http);
    expect(await daemon.health()).toEqual({
      ok: false,
      port: 1234,
      detail: "GET /health returned HTTP 503",
    });
  });

  test("the status match tolerates whitespace around the colon", async () => {
    const { http } = recordingHttp(() =>
      Promise.resolve({ status: 200, text: '{"status" :  "ok"}' }),
    );
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "1234" }), http);
    expect(await daemon.health()).toEqual({ ok: true, port: 1234, detail: "ok" });
  });

  test("a thrown Error becomes 'GET /health failed: <message>' and keeps the port", async () => {
    const { http } = recordingHttp(() => Promise.reject(new Error("boom")));
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "1234" }), http);
    expect(await daemon.health()).toEqual({
      ok: false,
      port: 1234,
      detail: "GET /health failed: boom",
    });
  });

  test("a thrown non-Error is stringified into the detail", async () => {
    const { http } = recordingHttp(() => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the port stringifies non-Error rejections
      return Promise.reject("refused");
    });
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "1234" }), http);
    expect((await daemon.health()).detail).toBe("GET /health failed: refused");
  });
});

describe("createDaemonPort inFlight", () => {
  test("a whitespace-only token file counts as missing and skips the request", async () => {
    const { http, urls } = recordingHttp(() =>
      Promise.resolve({ status: 200, text: '{"handoffs":[]}' }),
    );
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "1234", "/s/token": "  \n" }), http);
    expect(await daemon.inFlight()).toEqual({
      ok: false,
      error: "daemon port/token not found under /s",
    });
    expect(urls).toEqual([]);
  });

  test("an invalid port with a valid token skips the request", async () => {
    const { http, urls } = recordingHttp(() =>
      Promise.resolve({ status: 200, text: '{"handoffs":[]}' }),
    );
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "0", "/s/token": "tok" }), http);
    expect(await daemon.inFlight()).toEqual({
      ok: false,
      error: "daemon port/token not found under /s",
    });
    expect(urls).toEqual([]);
  });

  test("non-string handoff fields fall back to '?' and a null worker", async () => {
    const { http } = recordingHttp(() =>
      Promise.resolve({
        status: 200,
        text: JSON.stringify({
          handoffs: [{ handoff_id: 7, to_agent: null, worker_id: 9, status: "dispatched" }],
        }),
      }),
    );
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "1234", "/s/token": "tok" }), http);
    expect(await daemon.inFlight()).toEqual({
      ok: true,
      dispatched: [{ handoffId: "?", agent: "?", workerId: null }],
      approved: 0,
    });
  });

  test("rows whose status is neither dispatched nor approved are counted in neither", async () => {
    const row = (
      status: string,
    ): { handoff_id: string; to_agent: string; worker_id: string; status: string } => ({
      handoff_id: "h",
      to_agent: "codex",
      worker_id: "w1",
      status,
    });
    const { http } = recordingHttp(() =>
      Promise.resolve({
        status: 200,
        text: JSON.stringify({
          handoffs: [
            { handoff_id: "h1", to_agent: "codex", worker_id: "w1", status: "dispatched" },
            row("pending"),
            row("completed"),
            row("approved"),
          ],
        }),
      }),
    );
    const daemon = createDaemonPort("/s", memFs({ "/s/port": "1234", "/s/token": "tok" }), http);
    expect(await daemon.inFlight()).toEqual({
      ok: true,
      dispatched: [{ handoffId: "h1", agent: "codex", workerId: "w1" }],
      approved: 1,
    });
  });
});

describe("createLogReader", () => {
  test("a file cursor on a missing file starts at offset 0", async () => {
    const { exec } = recordingExec({});
    const reader = createLogReader(memFs({}), exec, clock(0));
    expect(await reader.cursor({ kind: "file", path: "/nope" })).toEqual({
      kind: "offset",
      value: 0,
    });
  });

  test("an offset past the current size (rotated file) re-reads from 0", async () => {
    const { exec } = recordingExec({});
    const reader = createLogReader(memFs({ "/log": "fresh\n" }), exec, clock(0));
    const cursor: LogCursor = { kind: "offset", value: 100 };
    expect(await reader.readSince({ kind: "file", path: "/log" }, cursor)).toBe("fresh\n");
  });

  test("a since cursor on a file source reads from 0", async () => {
    const { exec } = recordingExec({});
    const reader = createLogReader(memFs({ "/log": "abcdef" }), exec, clock(0));
    const cursor: LogCursor = { kind: "since", value: 2 };
    expect(await reader.readSince({ kind: "file", path: "/log" }, cursor)).toBe("abcdef");
  });

  test("a journal read with an offset cursor asks journalctl for @0", async () => {
    const { exec, calls } = recordingExec({ stdout: "x" });
    const reader = createLogReader(memFs({}), exec, clock(0));
    const cursor: LogCursor = { kind: "offset", value: 5_000_000 };
    await reader.readSince(JOURNAL, cursor);
    expect(calls[0]?.[5]).toBe("@0");
  });

  test("a failing journalctl yields empty text even with stdout", async () => {
    const { exec } = recordingExec({ code: 1, stdout: "partial\n" });
    const reader = createLogReader(memFs({}), exec, clock(0));
    const cursor: LogCursor = { kind: "since", value: 0 };
    expect(await reader.readSince(JOURNAL, cursor)).toBe("");
  });

  test("a none source reads empty without running anything", async () => {
    const { exec, calls } = recordingExec({ stdout: "x" });
    const reader = createLogReader(memFs({}), exec, clock(0));
    const cursor: LogCursor = { kind: "offset", value: 0 };
    expect(await reader.readSince(NONE, cursor)).toBe("");
    expect(calls).toEqual([]);
  });

  test("journal and none sources take a since cursor from the clock", async () => {
    const { exec } = recordingExec({});
    const reader = createLogReader(memFs({}), exec, clock(42));
    expect(await reader.cursor(JOURNAL)).toEqual({ kind: "since", value: 42 });
    expect(await reader.cursor(NONE)).toEqual({ kind: "since", value: 42 });
  });
});
