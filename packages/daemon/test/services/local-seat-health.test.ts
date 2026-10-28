import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalSeatHealthService,
  type LocalSeatHealthAgent,
  type LocalSeatHealthLog,
  type SeatHealthRecord,
} from "@src/services/local-seat-health.js";

const localSeat = {
  name: "local-bge",
  roles: ["reviewer"],
  adapter: "openai-compat-http",
  options: { baseUrl: "http://127.0.0.1:7944", model: "bge-m3" },
};

describe("local seat health service", () => {
  test("admits a healthy local openai-compatible seat when its model is served", async () => {
    const service = createLocalSeatHealthService({
      agents: () => [localSeat],
      ttlMs: 20_000,
      fetch: () =>
        new Response(
          JSON.stringify({ data: [{ id: "bge-m3-GGUF/bge-m3-FP16.gguf" }, { id: "bge-m3" }] }),
        ),
    });

    await service.refresh();

    expect(service.getUnhealthyAgents()).toEqual(new Set());
  });

  test("fails closed for down or unknown local seats but never excludes non-local seats", async () => {
    const cloudSeat = {
      name: "cloud-http",
      roles: ["reviewer"],
      adapter: "openai-compat-http",
      options: { baseUrl: "https://api.example.invalid", model: "missing" },
    };
    let calls = 0;
    const service = createLocalSeatHealthService({
      agents: () => [localSeat, cloudSeat],
      ttlMs: 20_000,
      fetch: () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [{ id: "different-model" }] }));
      },
    });

    await service.refresh();

    expect(calls).toBe(1);
    expect(service.getUnhealthyAgents()).toEqual(new Set(["local-bge"]));
  });

  test("does not re-probe a local seat inside the TTL window", async () => {
    let now = 1_000;
    let calls = 0;
    const service = createLocalSeatHealthService({
      agents: () => [localSeat],
      ttlMs: 20_000,
      now: () => now,
      fetch: () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [{ id: "bge-m3" }] }));
      },
    });

    await service.refresh();
    await service.refresh();
    now += 20_001;
    await service.refresh();

    expect(calls).toBe(2);
  });
});

type ProbeCall = {
  url: string;
  init?: { headers?: Record<string, string>; tls?: { ca: string } };
};

function tempSeatDir(): string {
  return mkdtempSync(join(tmpdir(), "seat-health-"));
}

type DeclaredHealth = {
  url: string;
  bearer_file?: string;
  ca_file?: string;
  expect_model?: string;
};

const declaredAcpSeat = (health: DeclaredHealth): LocalSeatHealthAgent => ({
  name: "acp-seat",
  adapter: "stdio-acp",
  options: {},
  health,
});

type LogCall = { obj: Record<string, unknown>; msg: string };

function recordingLog(): { warns: LogCall[]; infos: LogCall[]; log: LocalSeatHealthLog } {
  const warns: LogCall[] = [];
  const infos: LogCall[] = [];
  const log: LocalSeatHealthLog = {
    warn: (obj, msg) => {
      warns.push({ obj, msg });
    },
    info: (obj, msg) => {
      infos.push({ obj, msg });
    },
  };
  return { warns, infos, log };
}

describe("declared health targets", () => {
  test("probes a declared health target for a stdio-acp seat with bearer and CA", async () => {
    const dir = tempSeatDir();
    writeFileSync(join(dir, "token"), "tok\n");
    writeFileSync(join(dir, "ca.pem"), "PEM");
    const calls: ProbeCall[] = [];
    const service = createLocalSeatHealthService({
      agents: () => [
        declaredAcpSeat({
          url: "https://gw.example.invalid:7843/v1",
          bearer_file: join(dir, "token"),
          ca_file: join(dir, "ca.pem"),
          expect_model: "qwen",
        }),
      ],
      ttlMs: 20_000,
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "qwen" }] })));
      },
    });

    await service.refresh();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://gw.example.invalid:7843/v1/models");
    expect(calls[0]?.init?.headers?.authorization).toBe("Bearer tok");
    expect(calls[0]?.init?.tls?.ca).toBe("PEM");
    expect(service.getUnhealthyAgents()).toEqual(new Set());
  });

  test("a 401 from the declared target marks the seat unhealthy", async () => {
    const service = createLocalSeatHealthService({
      agents: () => [
        declaredAcpSeat({
          url: "https://gw.example.invalid:7843/v1",
          expect_model: "qwen",
        }),
      ],
      ttlMs: 20_000,
      fetch: () => Promise.resolve(new Response("no", { status: 401 })),
    });

    await service.refresh();

    expect(service.getUnhealthyAgents()).toEqual(new Set(["acp-seat"]));
  });

  test("a missing bearer_file marks the seat unhealthy without probing", async () => {
    const dir = tempSeatDir();
    let calls = 0;
    const service = createLocalSeatHealthService({
      agents: () => [
        declaredAcpSeat({
          url: "https://gw.example.invalid:7843/v1",
          bearer_file: join(dir, "does-not-exist"),
          expect_model: "qwen",
        }),
      ],
      ttlMs: 20_000,
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "qwen" }] })));
      },
    });

    await service.refresh();

    expect(calls).toBe(0);
    expect(service.getUnhealthyAgents()).toEqual(new Set(["acp-seat"]));
  });

  test("without expect_model a 2xx probe is healthy", async () => {
    const service = createLocalSeatHealthService({
      agents: () => [declaredAcpSeat({ url: "https://gw.example.invalid:7843/v1" })],
      ttlMs: 20_000,
      fetch: () => Promise.resolve(new Response(JSON.stringify({ data: [{ id: "anything" }] }))),
    });

    await service.refresh();

    expect(service.getUnhealthyAgents()).toEqual(new Set());
  });

  test("a declared target on an openai-compat seat replaces its baseUrl probe", async () => {
    const seat = {
      name: "local-bge",
      adapter: "openai-compat-http",
      options: { baseUrl: "http://127.0.0.1:7944", model: "bge-m3" },
      health: { url: "http://10.9.9.9:8000" },
    };
    const urls: string[] = [];
    const servedSeat = createLocalSeatHealthService({
      agents: () => [seat],
      ttlMs: 20_000,
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "bge-m3" }] })));
      },
    });
    await servedSeat.refresh();
    expect(urls).toEqual(["http://10.9.9.9:8000/v1/models"]);
    expect(servedSeat.getUnhealthyAgents()).toEqual(new Set());

    const missingSeat = createLocalSeatHealthService({
      agents: () => [seat],
      ttlMs: 20_000,
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ data: [{ id: "some-other-model" }] }))),
    });
    await missingSeat.refresh();
    expect(missingSeat.getUnhealthyAgents()).toEqual(new Set(["local-bge"]));
  });
});

describe("seat health states and transitions", () => {
  const fileSentinel = ["zq", "-sentinel", "-7731"].join("");

  test("a 401 records unauthorized, warns once, recovers with one info, and never logs the bearer value", async () => {
    const { warns, infos, log } = recordingLog();
    const calls: ProbeCall[] = [];
    let status = 401;
    let nowMs = 1_000;
    const service = createLocalSeatHealthService({
      agents: () => [
        declaredAcpSeat({
          url: "https://gw.example.invalid:7843/v1",
          bearer_file: "/seat-files/bearer",
          expect_model: "qwen",
        }),
      ],
      ttlMs: 20_000,
      now: () => nowMs,
      readFile: () => Promise.resolve(fileSentinel),
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(
          status === 200
            ? new Response(JSON.stringify({ data: [{ id: "qwen" }] }))
            : new Response("no", { status }),
        );
      },
      log,
    });

    await service.refresh();

    expect(calls[0]?.init?.headers?.authorization).toBe(`Bearer ${fileSentinel}`);
    expect(service.getSeatHealth("acp-seat")).toEqual({
      state: "unauthorized",
      checkedAtMs: 1_000,
      httpStatus: 401,
    });
    expect(service.getUnhealthyAgents()).toEqual(new Set(["acp-seat"]));
    expect(warns).toHaveLength(1);
    expect(warns[0]?.obj).toMatchObject({
      event: "local_seat_health_failing",
      agent: "acp-seat",
      state: "unauthorized",
      http_status: 401,
    });
    expect(infos).toHaveLength(0);

    nowMs = 21_001;
    await service.refresh();
    expect(service.getSeatHealth("acp-seat")?.checkedAtMs).toBe(21_001);
    expect(warns).toHaveLength(1);

    status = 200;
    nowMs = 42_002;
    await service.refresh();
    expect(service.getSeatHealth("acp-seat")).toEqual({ state: "healthy", checkedAtMs: 42_002 });
    expect(service.getUnhealthyAgents()).toEqual(new Set());
    expect(infos).toHaveLength(1);
    expect(infos[0]?.obj).toMatchObject({
      event: "local_seat_health_recovered",
      agent: "acp-seat",
      state: "healthy",
      previous_state: "unauthorized",
    });
    expect(warns).toHaveLength(1);

    expect(JSON.stringify([...warns, ...infos])).not.toContain(fileSentinel);
  });

  test("classifies 403, 503, a rejected fetch and a missing model", async () => {
    const rows: { label: string; fetch: () => Promise<Response>; expected: SeatHealthRecord }[] = [
      {
        label: "403",
        fetch: (): Promise<Response> => Promise.resolve(new Response("no", { status: 403 })),
        expected: { state: "unauthorized", checkedAtMs: 5_000, httpStatus: 403 },
      },
      {
        label: "503",
        fetch: (): Promise<Response> => Promise.resolve(new Response("down", { status: 503 })),
        expected: { state: "http_error", checkedAtMs: 5_000, httpStatus: 503 },
      },
      {
        label: "rejected fetch",
        fetch: (): Promise<Response> => Promise.reject(new TypeError("fetch failed")),
        expected: { state: "unreachable", checkedAtMs: 5_000 },
      },
      {
        label: "missing model",
        fetch: (): Promise<Response> =>
          Promise.resolve(new Response(JSON.stringify({ data: [{ id: "other" }] }))),
        expected: { state: "model_missing", checkedAtMs: 5_000 },
      },
    ];

    for (const row of rows) {
      const service = createLocalSeatHealthService({
        agents: () => [
          declaredAcpSeat({ url: "https://gw.example.invalid:7843/v1", expect_model: "qwen" }),
        ],
        ttlMs: 20_000,
        now: () => 5_000,
        fetch: row.fetch,
      });

      await service.refresh();

      expect(service.getSeatHealth("acp-seat")).toEqual(row.expected);
      expect(service.getUnhealthyAgents()).toEqual(new Set(["acp-seat"]));
      if (row.label === "rejected fetch") {
        const record = service.getSeatHealth("acp-seat");
        if (record === undefined) throw new Error("expected a record");
        expect("httpStatus" in record).toBe(false);
      }
    }
  });

  test("credential read failures and an empty bearer file are config_error and send no probe", async () => {
    const cases: {
      label: string;
      health: DeclaredHealth;
      readFile: (path: string) => Promise<string>;
    }[] = [
      {
        label: "unreadable bearer file",
        health: {
          url: "https://gw.example.invalid:7843/v1",
          bearer_file: "/seat-files/bearer",
          expect_model: "qwen",
        },
        readFile: (): Promise<string> => Promise.reject(new Error("ENOENT")),
      },
      {
        label: "empty bearer file",
        health: {
          url: "https://gw.example.invalid:7843/v1",
          bearer_file: "/seat-files/bearer",
          expect_model: "qwen",
        },
        readFile: (): Promise<string> => Promise.resolve("  \n"),
      },
      {
        label: "unreadable ca file",
        health: {
          url: "https://gw.example.invalid:7843/v1",
          bearer_file: "/seat-files/bearer",
          ca_file: "/seat-files/ca.pem",
          expect_model: "qwen",
        },
        readFile: (path): Promise<string> =>
          path.endsWith("ca.pem") ? Promise.reject(new Error("ENOENT")) : Promise.resolve("abc"),
      },
    ];

    for (const item of cases) {
      let calls = 0;
      const service = createLocalSeatHealthService({
        agents: () => [declaredAcpSeat(item.health)],
        ttlMs: 20_000,
        now: () => 1_000,
        readFile: item.readFile,
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "qwen" }] })));
        },
      });

      await service.refresh();

      expect(service.getSeatHealth("acp-seat")?.state).toBe("config_error");
      expect(calls).toBe(0);
      expect(service.getUnhealthyAgents()).toEqual(new Set(["acp-seat"]));
    }
  });

  test("warns on a healthy-to-failing transition but not on a failing-to-failing change", async () => {
    const { warns, infos, log } = recordingLog();
    let mode: "ok" | "401" | "down" = "ok";
    let nowMs = 1_000;
    const service = createLocalSeatHealthService({
      agents: () => [
        declaredAcpSeat({ url: "https://gw.example.invalid:7843/v1", expect_model: "qwen" }),
      ],
      ttlMs: 20_000,
      now: () => nowMs,
      fetch: () => {
        if (mode === "ok") {
          return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "qwen" }] })));
        }
        if (mode === "401") {
          return Promise.resolve(new Response("no", { status: 401 }));
        }
        return Promise.reject(new TypeError("fetch failed"));
      },
      log,
    });

    await service.refresh();
    expect(service.getSeatHealth("acp-seat")?.state).toBe("healthy");
    expect(warns).toHaveLength(0);
    expect(infos).toHaveLength(0);

    mode = "401";
    nowMs = 21_001;
    await service.refresh();
    expect(service.getSeatHealth("acp-seat")?.state).toBe("unauthorized");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.obj).toMatchObject({ agent: "acp-seat", state: "unauthorized" });

    mode = "down";
    nowMs = 41_002;
    await service.refresh();
    expect(service.getSeatHealth("acp-seat")?.state).toBe("unreachable");
    expect(warns).toHaveLength(1);
    expect(infos).toHaveLength(0);
  });

  test("getSeatHealth is undefined for a seat that was never probed", () => {
    const service = createLocalSeatHealthService({
      agents: () => [
        declaredAcpSeat({ url: "https://gw.example.invalid:7843/v1", expect_model: "qwen" }),
      ],
      ttlMs: 20_000,
      now: () => 1_000,
      fetch: () => Promise.resolve(new Response(JSON.stringify({ data: [{ id: "qwen" }] }))),
    });

    expect(service.getSeatHealth("acp-seat")).toBeUndefined();
    expect(service.getSeatHealth("nope")).toBeUndefined();
  });
});
