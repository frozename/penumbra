import { reloadAgentChatConfig } from "@penumbra/config";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDreamingPromptBlock,
  createDreamingJudgePool,
  createDreamingJudgePoolFromAgentchat,
  type DreamingJudgeEntry,
  parseDreamingJudgeResponse,
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
            content: JSON.stringify({ promote, confidence, rationale: `vote:${String(promote)}` }),
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
    const fakeFetch: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : String(input);
      callLog.push(url);
      return Promise.resolve(
        url.includes("1111") ? makeVoteResponse(true, 0.9) : makeVoteResponse(false, 0.3),
      );
    };

    const judges: DreamingJudgeEntry[] = [
      { name: "j1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" },
      { name: "j2", baseUrl: "http://localhost:2222/v1", apiKey: "", model: "local" },
    ];
    const pool = createDreamingJudgePool(judges, fakeFetch);
    const results = await pool.judgeAll!({ body: "test", kind: "promote_t1" });

    expect(results).toHaveLength(2);
    expect(callLog).toHaveLength(2);
    const yesVote = results.find((r) => r.promote);
    const noVote = results.find((r) => !r.promote);
    expect(yesVote?.confidence).toBe(0.9);
    expect(noVote?.confidence).toBe(0.3);
  });

  it("returns judge_error sentinel for a failing judge without throwing", async () => {
    const fakeFetch: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return Promise.resolve(
        url.includes("1111")
          ? makeVoteResponse(true, 0.95)
          : new Response("server error", { status: 500 }),
      );
    };

    const judges: DreamingJudgeEntry[] = [
      { name: "j1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" },
      { name: "j2", baseUrl: "http://localhost:9999/v1", apiKey: "", model: "local" },
    ];
    const pool = createDreamingJudgePool(judges, fakeFetch);
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
    const fakeFetch: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : String(input);
      callLog.push(url);
      return Promise.resolve(makeVoteResponse(true, 0.8));
    };

    const judges: DreamingJudgeEntry[] = [
      { name: "j1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" },
      { name: "j2", baseUrl: "http://localhost:2222/v1", apiKey: "", model: "local" },
    ];
    const pool = createDreamingJudgePool(judges, fakeFetch);

    for (let i = 0; i < 4; i++) {
      await pool.judge({ body: "x", kind: "promote_t1" });
    }

    const j1Calls = callLog.filter((u) => u.includes("1111")).length;
    const j2Calls = callLog.filter((u) => u.includes("2222")).length;
    expect(j1Calls).toBe(2);
    expect(j2Calls).toBe(2);
  });

  it("returns yes verdict for promote=true response", async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(makeVoteResponse(true, 0.85));
    const pool = createDreamingJudgePool(
      [{ name: "j1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" }],
      fakeFetch,
    );
    const result = await pool.judge({ body: "good memory", kind: "promote_t1" });
    expect(result.verdict).toBe("yes");
    expect(result.confidence).toBe(0.85);
  });

  it("returns no verdict for promote=false response", async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(makeVoteResponse(false, 0.1));
    const pool = createDreamingJudgePool(
      [{ name: "j1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" }],
      fakeFetch,
    );
    const result = await pool.judge({ body: "noisy memory", kind: "promote_t1" });
    expect(result.verdict).toBe("no");
  });
});

// --- factory: agentchat config integration ---

const tmpConfigPath = join(tmpdir(), `dreaming-judge-pool-test-${String(process.pid)}`);

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

// --- pool: per-seat request extras ---

function readRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  return JSON.parse(typeof body === "string" ? body : "{}") as Record<string, unknown>;
}

const CANONICAL_BODY_KEYS = ["max_tokens", "messages", "model", "response_format", "temperature"];

describe("DreamingJudgePool request extras", () => {
  it("sends a seat's requestExtras in the POST body", async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch: typeof fetch = (_input, init) => {
      body = readRequestBody(init);
      return Promise.resolve(makeVoteResponse(true, 0.9));
    };
    const pool = createDreamingJudgePool(
      [
        {
          name: "gemma",
          baseUrl: "http://localhost:1111/v1",
          apiKey: "",
          model: "gemma-cand",
          requestExtras: { chat_template_kwargs: { enable_thinking: false } },
        },
      ],
      fakeFetch,
    );
    await pool.judge({ body: "candidate", kind: "promote_t1" });
    expect(body["chat_template_kwargs"]).toEqual({ enable_thinking: false });
  });

  it("FAIL-CLOSED: requestExtras cannot override the canonical request fields", async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch: typeof fetch = (_input, init) => {
      body = readRequestBody(init);
      return Promise.resolve(makeVoteResponse(true, 0.9));
    };
    const pool = createDreamingJudgePool(
      [
        {
          name: "hostile",
          baseUrl: "http://localhost:1111/v1",
          apiKey: "",
          model: "real-model",
          requestExtras: {
            max_tokens: 99999,
            model: "evil",
            messages: [],
            temperature: 2,
            response_format: { type: "text" },
          },
        },
      ],
      fakeFetch,
    );
    await pool.judge({ body: "candidate", kind: "promote_t1" });
    // The judge contract is owned by the code, not by agents.yaml.
    expect(body["max_tokens"]).toBe(256);
    expect(body["model"]).toBe("real-model");
    expect(body["temperature"]).toBe(0);
    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect(Array.isArray(body["messages"]) ? body["messages"].length : -1).toBe(1);
  });

  it("REGRESSION PIN: a seat without requestExtras sends exactly the canonical keys", async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch: typeof fetch = (_input, init) => {
      body = readRequestBody(init);
      return Promise.resolve(makeVoteResponse(true, 0.9));
    };
    const pool = createDreamingJudgePool(
      [{ name: "plain", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "m" }],
      fakeFetch,
    );
    await pool.judge({ body: "candidate", kind: "promote_t1" });
    expect(Object.keys(body).sort()).toEqual(CANONICAL_BODY_KEYS);
  });

  it("judgeAll inherits extras because it shares callJudge", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch: typeof fetch = (_input, init) => {
      bodies.push(readRequestBody(init));
      return Promise.resolve(makeVoteResponse(true, 0.9));
    };
    const seats: DreamingJudgeEntry[] = [
      {
        name: "a",
        baseUrl: "http://localhost:1111/v1",
        apiKey: "",
        model: "m",
        requestExtras: { chat_template_kwargs: { enable_thinking: false } },
      },
      { name: "b", baseUrl: "http://localhost:2222/v1", apiKey: "", model: "m" },
    ];
    const pool = createDreamingJudgePool(seats, fakeFetch);
    await pool.judgeAll!({ body: "candidate", kind: "promote_t1" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    expect(Object.keys(bodies[1] ?? {}).sort()).toEqual(CANONICAL_BODY_KEYS);
  });
});

describe("createDreamingJudgePoolFromAgentchat request extras", () => {
  it("threads requestExtras from agent options into the POST body", async () => {
    writeConfig(
      [
        `  - name: judge-1\n    adapter: openai-compat-http\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://localhost:1111/v1\n      requestExtras:\n        chat_template_kwargs:\n          enable_thinking: false`,
        `  - name: judge-2\n    adapter: openai-compat-http\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://localhost:2222/v1`,
      ].join("\n"),
    );
    const bodies = new Map<string, Record<string, unknown>>();
    const fakeFetch: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      bodies.set(url, readRequestBody(init));
      return Promise.resolve(makeVoteResponse(true, 0.9));
    };
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    try {
      const pool = createDreamingJudgePoolFromAgentchat(undefined, fakeFetch);
      expect(pool).not.toBeNull();
      await pool?.judgeAll!({ body: "candidate", kind: "promote_t1" });
      expect(
        bodies.get("http://localhost:1111/v1/chat/completions")?.["chat_template_kwargs"],
      ).toEqual({ enable_thinking: false });
      expect(
        Object.keys(bodies.get("http://localhost:2222/v1/chat/completions") ?? {}).sort(),
      ).toEqual(CANONICAL_BODY_KEYS);
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
    }
  });

  it("ignores malformed requestExtras instead of taking the pool down", async () => {
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    try {
      for (const malformed of ["not-an-object", "[1, 2]", "null", "7"]) {
        writeConfig(
          [
            `  - name: judge-1\n    adapter: openai-compat-http\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://localhost:1111/v1\n      requestExtras: ${malformed}`,
            `  - name: judge-2\n    adapter: openai-compat-http\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://localhost:2222/v1`,
          ].join("\n"),
        );
        const bodies: Record<string, unknown>[] = [];
        const fakeFetch: typeof fetch = (_input, init) => {
          bodies.push(readRequestBody(init));
          return Promise.resolve(makeVoteResponse(true, 0.9));
        };
        const pool = createDreamingJudgePoolFromAgentchat(undefined, fakeFetch);
        expect(pool).not.toBeNull();
        await pool?.judgeAll!({ body: "candidate", kind: "promote_t1" });
        expect(bodies).toHaveLength(2);
        for (const body of bodies) {
          expect(Object.keys(body).sort()).toEqual(CANONICAL_BODY_KEYS);
        }
      }
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
    }
  });
});
