import { AgentsConfigSchema, QuotasConfigSchema, RoutingConfigSchema } from "@penumbra/config";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import { runConfigSplit } from "../../src/commands/config-split.js";

let tempDirs: string[] = [];
let stdoutLines: string[] = [];
let stderrLines: string[] = [];
let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, "write">>;
let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, "write">>;

beforeEach(() => {
  tempDirs = [];
  stdoutLines = [];
  stderrLines = [];
  stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutLines.push(String(chunk));
    return true;
  });
  stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrLines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "penumbra-config-split-unit-"));
  tempDirs.push(dir);
  return dir;
}

function fixturePath(name: string): string {
  return join(import.meta.dir, "fixtures", name);
}

describe("runConfigSplit", () => {
  test("returns 2 with usage when source and dest are missing", async () => {
    const code = await runConfigSplit({});
    expect(code).toBe(2);
    expect(stderrLines.join("")).toContain("usage: penumbra config split");
  });

  test("returns 2 when only sourceDir is given without dest", async () => {
    const dir = await makeTempDir();
    const code = await runConfigSplit({ sourceDir: dir });
    expect(code).toBe(2);
  });

  test("returns 1 when the source file cannot be read", async () => {
    const dir = await makeTempDir();
    const code = await runConfigSplit({
      source: join(dir, "missing.yaml"),
      dest: join(dir, "out"),
    });
    expect(code).toBe(1);
    expect(stderrLines.join("")).toContain("failed to read source");
  });

  test("returns 1 with issue paths when the source config is invalid", async () => {
    const dir = await makeTempDir();
    const source = join(dir, "agentchat.yaml");
    writeFileSync(source, YAML.stringify({ agents: [{ adapter: "stdio-acp" }] }), "utf8");

    const code = await runConfigSplit({ source, dest: join(dir, "out") });
    expect(code).toBe(1);
    expect(stderrLines.join("")).toContain("invalid source config");
  });

  test("splits the legacy fixture into schema-valid files", async () => {
    const dest = await makeTempDir();
    const code = await runConfigSplit({
      source: fixturePath("agentchat-legacy.yaml"),
      dest,
    });

    expect(code).toBe(0);
    const agents = AgentsConfigSchema.parse(
      YAML.parse(readFileSync(join(dest, "agents.yaml"), "utf8")),
    );
    const routing = RoutingConfigSchema.parse(
      YAML.parse(readFileSync(join(dest, "routing.yaml"), "utf8")),
    );
    const quotas = QuotasConfigSchema.parse(
      YAML.parse(readFileSync(join(dest, "quotas.yaml"), "utf8")),
    );

    expect(agents.agents.map((a) => a.name)).toContain("claude-acp-sonnet");
    const personaNames = Object.keys(routing.personas ?? {});
    expect(personaNames).toContain("architect");
    expect(personaNames).toContain("security");
    expect(personaNames).toContain("simplifier");
    expect(routing.workloads?.review_adversarial).toMatchObject({ fan_out: 2 });
    expect(routing.workloads?.plan_refine).toMatchObject({ fan_out: 2 });
    expect(quotas.providers[0]?.name).toBe("anthropic");
  });

  test("normalizes legacy array-shaped personas and string synthesizers", async () => {
    const dir = await makeTempDir();
    const legacy = YAML.parse(readFileSync(fixturePath("agentchat-legacy.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    legacy["review_personas"] = ["claude-acp-sonnet"];
    legacy["planner_personas"] = ["claude-acp-sonnet"];
    legacy["review_synthesizer"] = "claude-acp-sonnet";
    legacy["plan_synthesizer"] = "claude-acp-sonnet";
    const source = join(dir, "agentchat.yaml");
    writeFileSync(source, YAML.stringify(legacy), "utf8");

    const dest = join(dir, "out");
    const code = await runConfigSplit({ source, dest });
    expect(code).toBe(0);

    const routing = RoutingConfigSchema.parse(
      YAML.parse(readFileSync(join(dest, "routing.yaml"), "utf8")),
    );
    expect(routing.personas?.["claude-acp-sonnet"]?.preferred_agent).toBe("claude-acp-sonnet");
    expect(routing.workloads?.review_adversarial?.synthesizer).toBe("claude-acp-sonnet");
    expect(routing.workloads?.plan_refine?.synthesizer).toBe("claude-acp-sonnet");
  });

  test("dry-run prints planned writes without touching the destination", async () => {
    const dir = await makeTempDir();
    const dest = join(dir, "out");
    const code = await runConfigSplit({
      source: fixturePath("agentchat-legacy.yaml"),
      dest,
      dryRun: true,
    });

    expect(code).toBe(0);
    const out = stdoutLines.join("");
    expect(out).toContain(`would write ${join(dest, "agents.yaml")}`);
    expect(out).toContain(`would write ${join(dest, "routing.yaml")}`);
    expect(out).toContain(`would write ${join(dest, "quotas.yaml")}`);
    expect(existsSync(dest)).toBe(false);
  });

  test("refuses to overwrite a populated destination without --force", async () => {
    const dest = await makeTempDir();
    writeFileSync(join(dest, "agents.yaml"), "agents: []\n", "utf8");

    const code = await runConfigSplit({
      source: fixturePath("agentchat-legacy.yaml"),
      dest,
    });
    expect(code).toBe(1);
    expect(stderrLines.join("")).toContain("destination already populated");

    const forced = await runConfigSplit({
      source: fixturePath("agentchat-legacy.yaml"),
      dest,
      force: true,
    });
    expect(forced).toBe(0);
    expect(readFileSync(join(dest, "agents.yaml"), "utf8")).not.toBe("agents: []\n");
  });

  test("copies legacy operator config files when sourceDir is given", async () => {
    const sourceDir = await makeTempDir();
    const dest = join(sourceDir, "out");
    mkdirSync(dest);
    writeFileSync(
      join(sourceDir, "agentchat.yaml"),
      readFileSync(fixturePath("agentchat-legacy.yaml"), "utf8"),
      "utf8",
    );
    writeFileSync(join(sourceDir, "workers.yaml"), "extras: []\n", "utf8");

    const code = await runConfigSplit({ sourceDir, dest });
    expect(code).toBe(0);
    expect(readFileSync(join(dest, "workers.yaml"), "utf8")).toBe("extras: []\n");
    expect(existsSync(join(dest, "projects.yaml"))).toBe(false);
  });
});
