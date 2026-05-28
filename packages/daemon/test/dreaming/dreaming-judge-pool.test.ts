import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadAgentChatConfig } from "@penumbra/config";
import {
  buildDreamingPromptBlock,
  parseDreamingJudgeResponse,
  createDreamingJudgePool,
  createDreamingJudgePoolFromAgentchat,
  type DreamingJudgeEntry,
} from "../../src/dreaming/dreaming-judge-pool.js";

beforeAll(() => {
  delete process.env["PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID"];
});

// --- unit: prompt builder ---

describe("buildDreamingPromptBlock", () => {
  it("includes body and kind in output", () => {
    const result = buildDreamingPromptBlock({ body: "some memory text", kind: "promote_t1" });
    expect(result).toContain("some memory text");
    expect(result).toContain("promote_t1");
    expect(result).toContain("Return promote: false when the content is ephemeral");
  });

  it("requests strict JSON output format", () => {
    const result = buildDreamingPromptBlock({ body: "x", kind: "link" });
    expect(result).toContain('"promote"');
    expect(result).toContain('"confidence"');
    expect(result).toContain('"rationale"');
  });
});

// --- unit: response parser ---

describe("parseDreamingJudgeResponse", () => {
  it("parses clean JSON", () => {
    const raw = '{"promote": true, "confidence": 0.9, "rationale": "good memory"}';
    const result = parseDreamingJudgeResponse(raw);
    expect(result.promote).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.rationale).toBe("good memory");
  });

  it("strips code fences", () => {
    const raw = '```json\n{"promote": false, "confidence": 0.2, "rationale": "noise"}\n```';
    const result = parseDreamingJudgeResponse(raw);
    expect(result.promote).toBe(false);
    expect(result.confidence).toBe(0.2);
  });

  it("tolerates trailing text after the JSON object", () => {
    const raw = '{"promote": true, "confidence": 0.8, "rationale": "ok"} some trailing garbage';
    const result = parseDreamingJudgeResponse(raw);
    expect(result.promote).toBe(true);
    expect(result.confidence).toBe(0.8);
  });

  it("returns parse_error sentinel on malformed input", () => {
    const result = parseDreamingJudgeResponse("not json at all");
    expect(result.promote).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.rationale).toBe("parse_error");
  });

  it("returns parse_error sentinel on empty string", () => {
    const result = parseDreamingJudgeResponse("");
    expect(result.rationale).toBe("parse_error");
  });
});

// --- pool: judgeAll fans out to all judges ---

function makeVoteResponse(promote: boolean, confidence: number): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ promote, confidence, rationale: `vote:${promote}` }),
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("DreamingJudgePool.judgeAll", () => {
  it("fans out to all judges in parallel and returns one result per judge", async () => {
    const callLog: string[] = [];
    const fakeFetch = async (url: string): Promise<Response> => {
      callLog.push(url as string);
      if ((url as string).includes("1111")) return makeVoteResponse(true, 0.9);
      return makeVoteResponse(false, 0.3);
    };

    const judges: DreamingJudgeEntry[] = [
      { name: "j1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" },
      { name: "j2", baseUrl: "http://localhost:2222/v1", apiKey: "", model: "local" },
    ];
    const pool = createDreamingJudgePool(judges, fakeFetch as typeof fetch);
    const results = await pool.judgeAll!({ body: "test", kind: "promote_t1" });

    expect(results).toHaveLength(2);
    expect(callLog).toHaveLength(2);
    const yesVote = results.find((r) => r.promote === true);
    const noVote = results.find((r) => r.promote === false);
    expect(yesVote?.confidence).toBe(0.9);
    expect(noVote?.confidence).toBe(0.3);
  });

  it("returns judge_error sentinel for a failing judge without throwing", async () => {
    const fakeFetch = async (url: string): Promise<Response> => {
      if ((url as string).includes("1111")) return makeVoteResponse(true, 0.95);
      return new Response("server error", { status: 500 });
    };

    const judges: DreamingJudgeEntry[] = [
      { name: "j1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" },
      { name: "j2", baseUrl: "http://localhost:9999/v1", apiKey: "", model: "local" },
    ];
    const pool = createDreamingJudgePool(judges, fakeFetch as typeof fetch);
    const results = await pool.judgeAll!({ body: "test", kind: "promote_t1" });

    expect(results).toHaveLength(2);
    const errVote = results.find((r) => r.rationale === "judge_error");
    expect(errVote).toBeDefined();
  });
});

// --- pool: judge round-robins ---

describe("DreamingJudgePool.judge", () => {
  it("round-robins across judges: 4 calls with 2 judges → each called exactly twice", async () => {
    const callLog: string[] = [];
    const fakeFetch = async (url: string): Promise<Response> => {
      callLog.push(url as string);
      return makeVoteResponse(true, 0.8);
    };

    const judges: DreamingJudgeEntry[] = [
      { name: "j1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" },
      { name: "j2", baseUrl: "http://localhost:2222/v1", apiKey: "", model: "local" },
    ];
    const pool = createDreamingJudgePool(judges, fakeFetch as typeof fetch);

    for (let i = 0; i < 4; i++) {
      await pool.judge({ body: "x", kind: "promote_t1" });
    }

    const j1Calls = callLog.filter((u) => u.includes("1111")).length;
    const j2Calls = callLog.filter((u) => u.includes("2222")).length;
    expect(j1Calls).toBe(2);
    expect(j2Calls).toBe(2);
  });

  it("returns yes verdict for promote=true response", async () => {
    const fakeFetch = async (): Promise<Response> => makeVoteResponse(true, 0.85);
    const pool = createDreamingJudgePool(
      [{ name: "j1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" }],
      fakeFetch as typeof fetch,
    );
    const result = await pool.judge({ body: "good memory", kind: "promote_t1" });
    expect(result.verdict).toBe("yes");
    expect(result.confidence).toBe(0.85);
  });

  it("returns no verdict for promote=false response", async () => {
    const fakeFetch = async (): Promise<Response> => makeVoteResponse(false, 0.1);
    const pool = createDreamingJudgePool(
      [{ name: "j1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" }],
      fakeFetch as typeof fetch,
    );
    const result = await pool.judge({ body: "noisy memory", kind: "promote_t1" });
    expect(result.verdict).toBe("no");
  });
});

// --- factory: agentchat config integration ---

const tmpConfigPath = join(tmpdir(), `dreaming-judge-pool-test-${process.pid}`);

afterAll(() => {
  rmSync(tmpConfigPath, { recursive: true, force: true });
});

function writeConfig(agentsYaml: string): void {
  mkdirSync(tmpConfigPath, { recursive: true });
  writeFileSync(join(tmpConfigPath, "agents.yaml"), `agents:\n${agentsYaml}\n`);
  writeFileSync(join(tmpConfigPath, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(tmpConfigPath, "quotas.yaml"), "providers: []\n");
  reloadAgentChatConfig();
}

describe("createDreamingJudgePoolFromAgentchat", () => {
  it("returns null when no agents match the dreaming-judge role", () => {
    writeConfig(
      `  - name: other-agent\n    adapter: openai-compat-http\n    roles:\n      - memory-refiner\n    options:\n      baseUrl: http://localhost:1111/v1\n`,
    );
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    try {
      const pool = createDreamingJudgePoolFromAgentchat();
      expect(pool).toBeNull();
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
    }
  });

  it("returns null when only 1 agent matches (insufficient for quorum)", () => {
    writeConfig(
      `  - name: judge-1\n    adapter: openai-compat-http\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://localhost:1111/v1\n`,
    );
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    try {
      const pool = createDreamingJudgePoolFromAgentchat();
      // 1 judge cannot satisfy the ≥2 quorum required by P1 auto-promote
      expect(pool).toBeNull();
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
    }
  });

  it("returns a pool when ≥2 agents match", () => {
    writeConfig(
      [
        `  - name: judge-1\n    adapter: openai-compat-http\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://localhost:1111/v1`,
        `  - name: judge-2\n    adapter: openai-compat-http\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://localhost:2222/v1`,
      ].join("\n"),
    );
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    try {
      const pool = createDreamingJudgePoolFromAgentchat();
      expect(pool).not.toBeNull();
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
    }
  });

  it("returns null when config file is missing", () => {
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    process.env["PENUMBRA_CONFIG_DIR"] = "/nonexistent/path/agentchat.yaml";
    try {
      const pool = createDreamingJudgePoolFromAgentchat();
      expect(pool).toBeNull();
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
    }
  });

  it("respects PENUMBRA_DREAMING_JUDGE_ROLE env override", () => {
    writeConfig(
      [
        `  - name: custom-1\n    adapter: openai-compat-http\n    roles:\n      - my-custom-role\n    options:\n      baseUrl: http://localhost:1111/v1`,
        `  - name: custom-2\n    adapter: openai-compat-http\n    roles:\n      - my-custom-role\n    options:\n      baseUrl: http://localhost:2222/v1`,
      ].join("\n"),
    );
    const savedConfig = process.env["PENUMBRA_CONFIG_DIR"];
    const savedRole = process.env["PENUMBRA_DREAMING_JUDGE_ROLE"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    process.env["PENUMBRA_DREAMING_JUDGE_ROLE"] = "my-custom-role";
    try {
      const pool = createDreamingJudgePoolFromAgentchat();
      expect(pool).not.toBeNull();
    } finally {
      if (savedConfig === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = savedConfig;
      if (savedRole === undefined) delete process.env["PENUMBRA_DREAMING_JUDGE_ROLE"];
      else process.env["PENUMBRA_DREAMING_JUDGE_ROLE"] = savedRole;
    }
  });
});
