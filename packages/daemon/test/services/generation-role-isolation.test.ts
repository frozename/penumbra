import type { Services } from "@penumbra/core";

import { reloadAgentChatConfig } from "@penumbra/config";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRequiredLlmRoleFloors } from "@src/services/subsystem-health.js";
import { resolveT2ExtractionJudge } from "@src/workers/t2-promotion.js";

test("extraction role override does not reassign the shared classifier role", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penumbra-extraction-role-"));
  const keys = [
    "PENUMBRA_CONFIG_DIR",
    "PENUMBRA_JUDGE_ROLE",
    "PENUMBRA_T2_EXTRACTION_ROLE",
  ] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  const nativeFetch = globalThis.fetch;
  const seen: string[] = [];
  const tokenLimits: number[] = [];
  try {
    process.env.PENUMBRA_CONFIG_DIR = directory;
    process.env.PENUMBRA_JUDGE_ROLE = "memory-refiner";
    process.env.PENUMBRA_T2_EXTRACTION_ROLE = "memory-extractor";
    writeFileSync(
      join(directory, "agents.yaml"),
      JSON.stringify({
        agents: [
          {
            name: "classifier",
            adapter: "openai-compat-http",
            api_provider: "local",
            roles: ["memory-refiner"],
            options: { baseUrl: "http://127.0.0.1:1", model: "incumbent" },
          },
          {
            name: "extractor",
            adapter: "openai-compat-http",
            api_provider: "local",
            roles: ["memory-extractor"],
            options: {
              baseUrl: "http://127.0.0.1:1",
              model: "candidate",
              maxTokens: 256,
              requestTimeoutMs: 1000,
              requestExtras: { max_tokens: 999999 },
            },
          },
        ],
      }),
    );
    writeFileSync(join(directory, "routing.yaml"), "default_roles: {}\n");
    writeFileSync(join(directory, "quotas.yaml"), "providers: []\n");
    reloadAgentChatConfig();
    globalThis.fetch = Object.assign(
      (
        _url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        if (typeof init?.body !== "string") throw new Error("expected JSON body");
        const body = JSON.parse(init.body) as { model: string; max_tokens: number };
        seen.push(body.model);
        tokenLimits.push(body.max_tokens);
        return Promise.resolve(
          Response.json({ choices: [{ message: { content: '{"memories":[]}' } }] }),
        );
      },
      { preconnect: () => undefined },
    );
    const judge = resolveT2ExtractionJudge({
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as unknown as Services);
    if (!judge) throw new Error("missing extraction factory");
    await judge("transcript");
    expect(seen).toEqual(["candidate"]);
    expect(tokenLimits).toEqual([256]);
    const floors = buildRequiredLlmRoleFloors({
      env: {
        PENUMBRA_T2_EXTRACTION_ROLE: "memory-extractor",
        PENUMBRA_JUDGE_ROLE: "memory-refiner",
      },
    });
    expect(floors.find((f) => f.consumer === "t2.promotion")?.role).toBe("memory-extractor");
    expect(process.env.PENUMBRA_JUDGE_ROLE).toBe("memory-refiner");
  } finally {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    reloadAgentChatConfig();
    rmSync(directory, { recursive: true, force: true });
  }
});
