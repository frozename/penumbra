import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { collectLlamactlInventory } from "../../src/index.js";

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
      fetch: async (url, init) => {
        expect(init?.signal).toBeDefined();
        if (String(url) === "http://127.0.0.1:7944/v1/models") {
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
        if (String(url) === "https://mac-mini.local:7945/v1/fleet/snapshot") {
          expect(init?.headers).toEqual({
            authorization: "Bearer ll_agt_secret",
          });
          expect(init?.tls).toEqual({ ca: "CERT" });
          return new Response(JSON.stringify({ ok: true }));
        }
        throw new Error(`unexpected url ${String(url)}`);
      },
      execFile: async () => ({ ok: false, stdout: "", stderr: "missing" }),
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
      fetch: async () => {
        throw new Error("down");
      },
      execFile: async () => {
        throw new Error("missing llamactl");
      },
    });

    expect(inventory.status).toBe("unavailable");
    expect(inventory.nodes).toEqual([]);
    expect(inventory.models).toEqual([]);
    expect(inventory.messages.join("\n")).toContain("kubeconfig not found");
  });
});
