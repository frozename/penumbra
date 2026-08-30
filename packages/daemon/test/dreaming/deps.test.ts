import { reloadAgentChatConfig } from "@penumbra/config";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DreamConfig } from "../../src/dreaming/config.js";

import { buildDreamCycleDeps, createDreamingRewriterCandidates } from "../../src/dreaming/deps.js";

const configDir = join(tmpdir(), `penumbra-rewriter-role-${crypto.randomUUID()}`);

afterEach(() => {
  delete process.env.PENUMBRA_CONFIG_DIR;
  delete process.env.PENUMBRA_DREAMING_REWRITER_ROLE;
  rmSync(configDir, { recursive: true, force: true });
});

test("falls back to the legacy dreaming rewriter environment candidate when no seat has its role", () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "agents.yaml"),
    "agents:\n  - name: unrelated\n    adapter: openai-compat-http\n    roles: [other]\n    options:\n      baseUrl: http://localhost:8080/v1\n",
  );
  writeFileSync(join(configDir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(configDir, "quotas.yaml"), "providers: []\n");
  process.env.PENUMBRA_CONFIG_DIR = configDir;
  reloadAgentChatConfig();

  const candidates = createDreamingRewriterCandidates({
    rewriterBaseUrl: "http://127.0.0.1:7944/v1",
    rewriterModel: "legacy-rewriter",
  } as DreamConfig);

  expect(candidates).toEqual([
    {
      name: "legacy-rewriter",
      baseUrl: "http://127.0.0.1:7944/v1",
      model: "legacy-rewriter",
      provider: "local",
      auth: { source: "none" },
    },
  ]);
});

test("buildDreamCycleDeps constructs with partial dream config", () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "agents.yaml"),
    "agents:\n  - name: unrelated\n    adapter: openai-compat-http\n    roles: [other]\n    options:\n      baseUrl: http://localhost:8080/v1\n",
  );
  writeFileSync(join(configDir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(configDir, "quotas.yaml"), "providers: []\n");
  process.env.PENUMBRA_CONFIG_DIR = configDir;
  reloadAgentChatConfig();
  const db = new Database(":memory:");

  try {
    const deps = buildDreamCycleDeps({}, db, {} as DreamConfig);

    expect(deps.rewriterCandidates).toEqual([]);
    expect(deps.contentQualityJudge).toBeUndefined();
  } finally {
    db.close();
  }
});
