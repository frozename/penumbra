import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalSeatHealthService,
  type LocalSeatHealthAgent,
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
