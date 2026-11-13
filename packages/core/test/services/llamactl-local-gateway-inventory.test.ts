import { expect, test } from "bun:test";

import { collectLlamactlInventory } from "@src/index.js";

const config = (nodes: unknown[], otherNodes: unknown[] = []): string =>
  JSON.stringify({
    apiVersion: "llamactl/v1",
    kind: "Config",
    currentContext: "dev",
    contexts: [{ name: "dev", cluster: "active", user: "operator", defaultNode: "local" }],
    clusters: [
      { name: "active", nodes },
      { name: "other", nodes: otherNodes },
    ],
    users: [{ name: "operator", token: "test-operator-token" }],
  });
const gateway = (baseUrl = "http://127.0.0.1:18944/v1"): Record<string, unknown> => ({
  name: "mini-on-demand",
  kind: "gateway",
  cloud: { provider: "openai-compatible", baseUrl },
});

test("discovers a registered anonymous loopback catalog even when the agent proxy lacks the model", async () => {
  const urls: string[] = [];
  const inventory = await collectLlamactlInventory({
    env: { LLAMACTL_CONFIG: "/isolated/config" },
    exists: (path) => path === "/isolated/config",
    readFile: () => config([gateway()], [gateway("http://127.0.0.1:18999/v1")]),
    includeLocalGateways: true,
    includeCatalog: false,
    execFile: () => {
      throw new Error("rewriter discovery must not spawn catalog commands");
    },
    fetch: (url, init) => {
      urls.push(url);
      if (url === "http://127.0.0.1:18944/v1/models") {
        expect(init?.headers).toBeUndefined();
        expect(init?.redirect).toBe("error");
        return Promise.resolve(
          Response.json({ data: [{ id: "granite/model.gguf", owned_by: "llamacpp" }] }),
        );
      }
      expect(url).toBe("http://127.0.0.1:7944/v1/models");
      return Promise.resolve(Response.json({ data: [] }));
    },
  });
  expect(urls.sort()).toEqual([
    "http://127.0.0.1:18944/v1/models",
    "http://127.0.0.1:7944/v1/models",
  ]);
  expect(inventory.models).toHaveLength(1);
  expect(inventory.models[0]?.id).toBe("granite/model.gguf");
  expect(inventory.models[0]?.node).toMatchObject({
    name: "mini-on-demand",
    endpoint: "http://127.0.0.1:18944/v1",
    healthy: true,
  });
  expect(inventory.models[0]?.node?.token).toBeUndefined();
});

for (const node of [
  gateway("https://api.example.com/v1"),
  gateway("http://192.168.1.40:8000/v1"),
  gateway("http://user:secret@127.0.0.1:18944/v1"),
  gateway("http://127.0.0.1:18944/v1?key=secret"),
  { ...gateway(), cloud: { provider: "openai", baseUrl: "http://127.0.0.1:18944/v1" } },
  {
    ...gateway(),
    cloud: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:18944/v1",
      apiKeyRef: "env:SECRET",
    },
  },
]) {
  test("does not probe hosted, credential-bearing or non-loopback gateway registrations", async () => {
    const urls: string[] = [];
    const inventory = await collectLlamactlInventory({
      env: { LLAMACTL_CONFIG: "/isolated/config" },
      exists: () => true,
      readFile: () => config([node]),
      includeLocalGateways: true,
      includeCatalog: false,
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve(Response.json({ data: [] }));
      },
    });
    expect(urls).toEqual(["http://127.0.0.1:7944/v1/models"]);
    expect(inventory.models).toEqual([]);
  });
}

test("honors active context and keeps gateway probing opt-in", async () => {
  const urls: string[] = [];
  await collectLlamactlInventory({
    env: { LLAMACTL_CONFIG: "/isolated/config" },
    exists: () => true,
    readFile: () => config([gateway()], [gateway("http://127.0.0.1:18999/v1")]),
    includeCatalog: false,
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve(Response.json({ data: [] }));
    },
  });
  expect(urls).toEqual(["http://127.0.0.1:7944/v1/models"]);
});

test("parses the current registry's active agent node credentials and certificate", async () => {
  const inventory = await collectLlamactlInventory({
    env: { LLAMACTL_CONFIG: "/isolated/config" },
    exists: () => true,
    readFile: () =>
      config([
        {
          name: "worker",
          kind: "agent",
          endpoint: "https://worker.local:7843",
          certificate: "CERT",
          certificateFingerprint: "sha256:test",
        },
      ]),
    includeCatalog: false,
    fetch: (url, init) => {
      if (url.endsWith("/v1/fleet/snapshot")) {
        expect(init?.headers).toEqual({ authorization: "Bearer test-operator-token" });
        expect(init?.tls).toEqual({ ca: "CERT" });
        return Promise.resolve(Response.json({ ok: true }));
      }
      return Promise.resolve(Response.json({ data: [{ id: "worker-model", owned_by: "worker" }] }));
    },
  });
  expect(inventory.nodes[0]).toMatchObject({
    name: "worker",
    healthy: true,
    fingerprint: "sha256:test",
  });
});

test("registered local catalog redirects never reach a second origin", async () => {
  let followed = 0;
  let requested = 0;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      followed++;
      return Response.json({ data: [{ id: "unexpected" }] });
    },
  });
  const redirector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requested++;
      return Response.redirect(target.url.toString() + "v1/models", 302);
    },
  });
  try {
    const inventory = await collectLlamactlInventory({
      env: { LLAMACTL_CONFIG: "/isolated/config" },
      exists: () => true,
      readFile: () => config([gateway(redirector.url.toString() + "v1")]),
      includeLocalGateways: true,
      includeCatalog: false,
      fetch: (url, init) =>
        url === "http://127.0.0.1:7944/v1/models"
          ? Promise.resolve(Response.json({ data: [] }))
          : fetch(url, init),
    });
    expect(requested).toBe(1);
    expect(followed).toBe(0);
    expect(inventory.models).toEqual([]);
    expect(inventory.nodes[0]?.healthy).toBe(false);
  } finally {
    await redirector.stop(true);
    await target.stop(true);
  }
});
