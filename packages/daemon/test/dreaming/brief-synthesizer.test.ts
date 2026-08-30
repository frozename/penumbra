import { reloadAgentChatConfig } from "@penumbra/config";
import {
  type BriefSynthesizerInput,
  buildBriefPrompt,
  createBriefSynthesizer,
  createBriefSynthesizerFromAgentchat,
  parseSynthesizerResponse,
} from "@src/dreaming/brief-synthesizer.js";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeAll(() => {
  delete process.env["PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID"];
});

// --- unit: prompt builder ---

describe("buildBriefPrompt", () => {
  it("includes project_id in the output", () => {
    const input: BriefSynthesizerInput = {
      project_id: "my-project",
      recent_memories: [],
    };
    const result = buildBriefPrompt(input);
    expect(result).toContain("my-project");
    expect(result).toContain("# Project Brief: my-project");
  });

  it("includes memory bodies in the output", () => {
    const input: BriefSynthesizerInput = {
      project_id: "proj",
      recent_memories: [
        {
          memory_id: "m1",
          kind: "knowledge",
          title: "topic A",
          body: "body content A",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          memory_id: "m2",
          kind: "feedback",
          title: "topic B",
          body: "body content B",
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
    };
    const result = buildBriefPrompt(input);
    expect(result).toContain("body content A");
    expect(result).toContain("body content B");
    expect(result).toContain("topic A");
    expect(result).toContain("topic B");
  });

  it("includes prior_brief when provided", () => {
    const input: BriefSynthesizerInput = {
      project_id: "proj",
      recent_memories: [],
      prior_brief: "This is the prior brief content.",
    };
    const result = buildBriefPrompt(input);
    expect(result).toContain("This is the prior brief content.");
    expect(result).toContain("Prior Brief");
  });

  it("omits prior brief section when not provided", () => {
    const input: BriefSynthesizerInput = {
      project_id: "proj",
      recent_memories: [],
    };
    const result = buildBriefPrompt(input);
    expect(result).not.toContain("Prior Brief");
  });
});

// --- unit: response parser ---

describe("parseSynthesizerResponse", () => {
  it("returns content as-is when no code fences", () => {
    const raw = "# Project Brief: proj\n\nSome content here.";
    expect(parseSynthesizerResponse(raw)).toBe("# Project Brief: proj\n\nSome content here.");
  });

  it("strips leading and trailing triple-backtick code fences", () => {
    const raw = "```markdown\n# Project Brief: proj\n\nContent.\n```";
    const result = parseSynthesizerResponse(raw);
    expect(result).toBe("# Project Brief: proj\n\nContent.");
    expect(result).not.toContain("```");
  });

  it("strips plain ``` fences without language tag", () => {
    const raw = "```\n# Project Brief: proj\n```";
    const result = parseSynthesizerResponse(raw);
    expect(result).toBe("# Project Brief: proj");
    expect(result).not.toContain("```");
  });

  it("trims surrounding whitespace", () => {
    const raw = "  \n# Project Brief: proj\n\nContent.\n  ";
    expect(parseSynthesizerResponse(raw)).toBe("# Project Brief: proj\n\nContent.");
  });
});

// --- synthesizer: HTTP call ---

function makeMarkdownResponse(markdown: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: markdown } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("BriefSynthesizer.synthesize", () => {
  it("fans out to configured agent and returns markdown + source_memory_ids", async () => {
    const callLog: string[] = [];
    const fakeMarkdown = "# Project Brief: test-proj\n\nThis is the synthesized brief.";
    const fakeFetch: typeof fetch = (input) => {
      callLog.push(fetchInputUrl(input));
      return Promise.resolve(makeMarkdownResponse(fakeMarkdown));
    };

    const synthesizer = createBriefSynthesizer(
      [{ name: "s1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" }],
      fakeFetch,
    );

    const input: BriefSynthesizerInput = {
      project_id: "test-proj",
      recent_memories: [
        {
          memory_id: "mA",
          kind: "knowledge",
          title: "T",
          body: "B",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    const result = await synthesizer.synthesize(input);
    expect(result.markdown).toBe(fakeMarkdown);
    expect(result.source_memory_ids).toEqual(["mA"]);
    expect(callLog).toHaveLength(1);
    expect(callLog[0]).toContain("1111");
  });

  it("strips code fences from agent response", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(makeMarkdownResponse("```markdown\n# Project Brief: proj\n\nContent.\n```"));

    const synthesizer = createBriefSynthesizer(
      [{ name: "s1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" }],
      fakeFetch,
    );

    const result = await synthesizer.synthesize({ project_id: "proj", recent_memories: [] });
    expect(result.markdown).not.toContain("```");
    expect(result.markdown).toContain("# Project Brief: proj");
  });

  it("throws when agent returns non-2xx", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(new Response("server error", { status: 500 }));
    const synthesizer = createBriefSynthesizer(
      [{ name: "s1", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" }],
      fakeFetch,
    );
    let thrown: unknown;
    try {
      await synthesizer.synthesize({ project_id: "proj", recent_memories: [] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  it("fails over to a healthy agent when the first is down", async () => {
    const callLog: string[] = [];
    const fakeFetch: typeof fetch = (input) => {
      const url = fetchInputUrl(input);
      callLog.push(url);
      if (url.includes("1111")) return Promise.reject(new Error("ConnectionRefused"));
      return Promise.resolve(
        makeMarkdownResponse("# Project Brief: proj\n\nFrom the healthy seat."),
      );
    };
    const synthesizer = createBriefSynthesizer(
      [
        { name: "down", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" },
        { name: "up", baseUrl: "http://localhost:2222/v1", apiKey: "", model: "local" },
      ],
      fakeFetch,
    );
    const result = await synthesizer.synthesize({ project_id: "proj", recent_memories: [] });
    expect(result.markdown).toContain("From the healthy seat.");
    expect(callLog.some((u) => u.includes("1111"))).toBe(true); // tried the down seat
    expect(callLog.some((u) => u.includes("2222"))).toBe(true); // failed over to the healthy one
  });

  it("throws only when EVERY agent fails (caller then falls back to stub)", async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(new Response("err", { status: 502 }));
    const synthesizer = createBriefSynthesizer(
      [
        { name: "a", baseUrl: "http://localhost:1111/v1", apiKey: "", model: "local" },
        { name: "b", baseUrl: "http://localhost:2222/v1", apiKey: "", model: "local" },
      ],
      fakeFetch,
    );
    let thrown: unknown;
    try {
      await synthesizer.synthesize({ project_id: "proj", recent_memories: [] });
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error)) throw new TypeError("expected synthesizer to throw");
    expect(thrown.message).toMatch(/all brief synthesizer agents failed/);
  });
});

// --- factory: agentchat config integration ---

const tmpConfigPath = join(tmpdir(), `brief-synthesizer-test-${String(process.pid)}`);

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

describe("createBriefSynthesizerFromAgentchat", () => {
  it("returns null when no agents match the brief-synthesizer role", () => {
    writeConfig(
      `  - name: other-agent\n    adapter: openai-compat-http\n    api_provider: local\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://localhost:1111/v1\n`,
    );
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    try {
      const synth = createBriefSynthesizerFromAgentchat();
      expect(synth).toBeNull();
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
    }
  });

  it("logs when matching role candidates are filtered out", () => {
    writeConfig(
      `  - name: public-agent\n    adapter: openai-compat-http\n    api_provider: local\n    roles:\n      - brief-synthesizer\n    options:\n      baseUrl: https://api.openai.com/v1\n      provider: openai\n`,
    );
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    const warnCalls: { fields: unknown[]; msg: string }[] = [];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    try {
      const synth = createBriefSynthesizerFromAgentchat({
        log: {
          warn: (...args: unknown[]) => {
            warnCalls.push({
              fields: args.slice(0, -1),
              msg: ((): string => {
                const lastArg = args.at(-1);
                if (lastArg === undefined) return "";
                if (typeof lastArg === "string") return lastArg;
                if (lastArg instanceof Error) return lastArg.message;
                if (lastArg !== null && typeof lastArg === "object") {
                  const serialized = JSON.stringify(lastArg) as unknown;
                  return typeof serialized === "string" ? serialized : "";
                }
                if (typeof lastArg === "number") return lastArg.toString();
                if (typeof lastArg === "boolean") return lastArg.toString();
                if (typeof lastArg === "bigint") return lastArg.toString();
                if (typeof lastArg === "symbol") return lastArg.description ?? "";
                return "";
              })(),
            });
          },
        },
      });
      expect(synth).toBeNull();
      expect(warnCalls.some((call) => call.msg.includes("no admitted agents"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
    }
  });

  it("returns a synthesizer when 1 matching agent exists", () => {
    writeConfig(
      `  - name: synth-1\n    adapter: openai-compat-http\n    api_provider: local\n    roles:\n      - brief-synthesizer\n    options:\n      baseUrl: http://localhost:1111/v1\n`,
    );
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    try {
      const synth = createBriefSynthesizerFromAgentchat();
      expect(synth).not.toBeNull();
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
    }
  });

  it("returns null when config file is missing", () => {
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    process.env["PENUMBRA_CONFIG_DIR"] = "/nonexistent/path/agentchat.yaml";
    try {
      const synth = createBriefSynthesizerFromAgentchat();
      expect(synth).toBeNull();
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
    }
  });

  it("rejects public API endpoints by default and returns null", () => {
    writeConfig(
      `  - name: public-agent\n    adapter: openai-compat-http\n    api_provider: local\n    roles:\n      - brief-synthesizer\n    options:\n      baseUrl: https://api.openai.com/v1\n      provider: openai\n`,
    );
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    const savedAllow = process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    delete process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC"];
    try {
      const synth = createBriefSynthesizerFromAgentchat();
      expect(synth).toBeNull();
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
      if (savedAllow === undefined)
        delete process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC"];
      else process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC"] = savedAllow;
    }
  });

  it("does not admit a public API endpoint even when the legacy override is set", () => {
    writeConfig(
      `  - name: public-agent\n    adapter: openai-compat-http\n    api_provider: local\n    roles:\n      - brief-synthesizer\n    options:\n      baseUrl: https://api.openai.com/v1\n      provider: openai\n`,
    );
    const saved = process.env["PENUMBRA_CONFIG_DIR"];
    const savedAllow = process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC"] = "1";
    try {
      const synth = createBriefSynthesizerFromAgentchat();
      expect(synth).toBeNull();
    } finally {
      if (saved === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = saved;
      if (savedAllow === undefined)
        delete process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC"];
      else process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC"] = savedAllow;
    }
  });

  it("respects PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ROLE env override", () => {
    writeConfig(
      `  - name: custom-synth\n    adapter: openai-compat-http\n    api_provider: local\n    roles:\n      - my-brief-role\n    options:\n      baseUrl: http://localhost:1111/v1\n`,
    );
    const savedConfig = process.env["PENUMBRA_CONFIG_DIR"];
    const savedRole = process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ROLE"];
    process.env["PENUMBRA_CONFIG_DIR"] = tmpConfigPath;
    process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ROLE"] = "my-brief-role";
    try {
      const synth = createBriefSynthesizerFromAgentchat();
      expect(synth).not.toBeNull();
    } finally {
      if (savedConfig === undefined) delete process.env["PENUMBRA_CONFIG_DIR"];
      else process.env["PENUMBRA_CONFIG_DIR"] = savedConfig;
      if (savedRole === undefined) delete process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ROLE"];
      else process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ROLE"] = savedRole;
    }
  });
});
