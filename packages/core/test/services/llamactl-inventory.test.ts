import { collectLlamactlInventory } from "@src/index.js";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const kubeconfig = [
  "apiVersion: v1",
  "kind: Config",
  "current-context: mac-mini",
  "clusters:",
  "  - name: mac-mini",
  "    cluster:",
  "      server: https://mac-mini.local:7945",
  "      certificate-authority-data: Q0VSVA==",
  "      extensions:",
  "        - name: llamactl",
  "          extension:",
  "            kind: agent",
  "            fingerprint: sha256:abc",
  "contexts:",
  "  - name: mac-mini",
  "    context:",
  "      cluster: mac-mini",
  "      user: mac-mini-user",
  "users:",
  "  - name: mac-mini-user",
  "    user:",
  "      token: ll_agt_secret",
  "",
].join("\n");

describe("llamactl inventory", () => {
  test("parses kubeconfig nodes and dedupes served model aliases by owner and creation", async () => {
    const inventory = await collectLlamactlInventory({
      env: { DEV_STORAGE: "/dev-storage" },
      readFile: (path) => {
        expect(path).toBe(join("/dev-storage", "config"));
        return kubeconfig;
      },
      exists: (path) => path === join("/dev-storage", "config"),
      fetch: (url, init) => {
        expect(init?.signal).toBeDefined();
        if (url === "http://127.0.0.1:7944/v1/models") {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "models/granite-4.1-3b-Q8_0.gguf",
                  owned_by: "mac-mini",
                  created: 100,
                },
                { id: "granite-4.1-3b-Q8_0.gguf", owned_by: "mac-mini", created: 100 },
                { id: "other.gguf", owned_by: "mac-mini", created: 101 },
              ],
            }),
          );
        }
        if (url === "https://mac-mini.local:7945/v1/fleet/snapshot") {
          expect(init?.headers).toEqual({
            authorization: "Bearer ll_agt_secret",
          });
          expect(init?.tls).toEqual({ ca: "CERT" });
          return new Response(JSON.stringify({ ok: true }));
        }
        throw new Error(`unexpected url ${url}`);
      },
      execFile: () => ({ ok: false, stdout: "", stderr: "missing" }),
    });

    expect(inventory.status).toBe("ok");
    expect(inventory.nodes).toEqual([
      {
        name: "mac-mini",
        endpoint: "https://mac-mini.local:7945",
        certificatePem: "CERT",
        fingerprint: "sha256:abc",
        token: "ll_agt_secret",
        healthy: true,
      },
    ]);
    expect(inventory.models.map((model) => model.id)).toEqual([
      "granite-4.1-3b-Q8_0.gguf",
      "other.gguf",
    ]);
    expect(inventory.models[0]?.node?.endpoint).toBe("https://mac-mini.local:7945");
  });

  test("degrades gracefully when kubeconfig and llamactl are absent", async () => {
    const inventory = await collectLlamactlInventory({
      env: { HOME: "/home/test" },
      exists: () => false,
      readFile: () => {
        throw new Error("should not read");
      },
      fetch: () => {
        throw new Error("down");
      },
      execFile: () => {
        throw new Error("missing llamactl");
      },
    });

    expect(inventory.status).toBe("unavailable");
    expect(inventory.nodes).toEqual([]);
    expect(inventory.models).toEqual([]);
    expect(inventory.messages.join("\n")).toContain("kubeconfig not found");
  });

  test("dedupes alias path+bare pairs but keeps unrelated same-owner models distinct", async () => {
    const inventory = await collectLlamactlInventory({
      env: { DEV_STORAGE: "/dev-storage" },
      readFile: (path) => {
        expect(path).toBe(join("/dev-storage", "config"));
        return kubeconfig;
      },
      exists: (path) => path === join("/dev-storage", "config"),
      fetch: (url, init) => {
        expect(init?.signal).toBeDefined();
        if (url === "http://127.0.0.1:7944/v1/models") {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "LFM2.5-8B-A1B-MoQ/MoQ-4.25.gguf",
                  owned_by: "mac-mini",
                  created: 1781009551,
                },
                { id: "lfm2-generator", owned_by: "mac-mini", created: 1781009551 },
                { id: "bge-m3", owned_by: "llamactl-agent", created: 0 },
                { id: "granite-mini-3b", owned_by: "llamactl-agent", created: 0 },
                {
                  id: "Open4bits/Qwen3-Coder-Next-mlx-2Bit",
                  owned_by: "llamactl-host",
                  created: 1781188394,
                },
                {
                  id: "Qwen3-Coder-Next-mlx-2Bit",
                  owned_by: "llamactl-host",
                  created: 1781188394,
                },
              ],
            }),
          );
        }
        if (url === "https://mac-mini.local:7945/v1/fleet/snapshot") {
          return new Response(JSON.stringify({ ok: true }));
        }
        throw new Error(`unexpected url ${url}`);
      },
      execFile: () => ({ ok: false, stdout: "", stderr: "missing" }),
    });

    expect(inventory.status).toBe("ok");
    expect(inventory.models.map((model) => model.id)).toEqual([
      "LFM2.5-8B-A1B-MoQ/MoQ-4.25.gguf",
      "lfm2-generator",
      "bge-m3",
      "granite-mini-3b",
      "Qwen3-Coder-Next-mlx-2Bit",
    ]);
  });
});
