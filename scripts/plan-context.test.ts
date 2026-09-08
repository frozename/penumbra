import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  computeSeatContext,
  isBiasActive,
  parseAgentNames,
  parseBiases,
  type SeatContext,
  type SeatInput,
} from "./plan-context-seats.js";
import {
  buildGateContext,
  extractHeadingPrefixes,
  extractPhaseHeaderRegex,
  extractSchemaRules,
  extractValidatorRules,
  findGitignoreEntry,
  parseCiSteps,
  PlanContextError,
  probePhaseHeader,
  readSources,
} from "./plan-context-sources.js";
import {
  buildPlanContext,
  parseArgs,
  PlanContextUsageError,
  readDaemonHandle,
  renderMarkdown,
  resolveStorageRoot,
  summaryLine,
} from "./plan-context.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPT = resolve(import.meta.dir, "plan-context.ts");

const SEATS: SeatInput[] = [
  {
    maestro_capable: true,
    name: "alpha-acp",
    pricing_mode: "subscription",
    subscription_provider: "openai",
  },
  {
    maestro_capable: true,
    name: "beta-acp",
    pricing_mode: "subscription",
    subscription_provider: "openai",
  },
  {
    maestro_capable: true,
    name: "gamma-acp",
    pricing_mode: "subscription",
    subscription_provider: "gogo",
  },
  {
    maestro_capable: true,
    name: "delta-acp",
    pricing_mode: "subscription",
    subscription_provider: "fenced",
  },
  {
    maestro_capable: true,
    name: "unregistered-acp",
    pricing_mode: "subscription",
    subscription_provider: "openai",
  },
  {
    maestro_capable: false,
    name: "not-capable-acp",
    pricing_mode: "subscription",
    subscription_provider: "openai",
  },
];
const REGISTERED = ["alpha-acp", "beta-acp", "gamma-acp", "delta-acp", "not-capable-acp"];
const NOW = new Date("2026-09-07T12:00:00.000Z");

function seatContext(biases: Parameters<typeof computeSeatContext>[0]["biases"]): SeatContext {
  return computeSeatContext({
    biases,
    now: NOW,
    registered: REGISTERED,
    seats: SEATS,
  });
}

describe("seat eligibility", () => {
  test("keeps only registered, maestro_capable seats and drops the bias-excluded ones", () => {
    const context = seatContext([
      {
        expires_at: "2026-09-08T00:00:00.000Z",
        mode: "exclude",
        scope: "provider",
        value: "fenced",
      },
    ]);

    expect(context.eligible.map((seat) => seat.name)).toEqual([
      "alpha-acp",
      "beta-acp",
      "gamma-acp",
    ]);
    expect(context.excluded_by_bias.map((seat) => seat.name)).toEqual(["delta-acp"]);
    expect(context.maestro_capable_unregistered).toEqual(["unregistered-acp"]);
    expect(context.maestro_capable_count).toBe(5);
    expect(context.registered_count).toBe(5);
  });

  test("an EXPIRED exclude no longer fences the seat", () => {
    const context = seatContext([
      {
        expires_at: "2026-09-07T11:59:59.000Z",
        mode: "exclude",
        scope: "provider",
        value: "fenced",
      },
    ]);

    expect(context.eligible.map((seat) => seat.name)).toContain("delta-acp");
    expect(context.excluded_by_bias).toEqual([]);
  });

  test("an agent-scoped exclude fences exactly one seat", () => {
    const context = seatContext([{ mode: "exclude", scope: "agent", value: "beta-acp" }]);

    expect(context.eligible.map((seat) => seat.name)).not.toContain("beta-acp");
    expect(context.excluded_by_bias[0]?.bias?.scope).toBe("agent");
  });

  test("a live boost promotes a seat to preferred and the fallback crosses providers", () => {
    const context = seatContext([
      { mode: "boost", scope: "agent", value: "gamma-acp", weight: 3 },
      {
        expires_at: "2026-09-08T00:00:00.000Z",
        mode: "exclude",
        scope: "provider",
        value: "fenced",
      },
    ]);

    expect(context.preferred_agent).toBe("gamma-acp");
    expect(context.fallback_agent).toBe("alpha-acp");
    expect(context.selection_reason).toContain("different provider");
  });

  test("a single eligible seat repeats itself as the fallback and says so", () => {
    const context = computeSeatContext({
      biases: [],
      now: NOW,
      registered: ["alpha-acp"],
      seats: SEATS,
    });

    expect(context.preferred_agent).toBe("alpha-acp");
    expect(context.fallback_agent).toBe("alpha-acp");
    expect(context.selection_reason).toContain("single eligible seat");
  });

  test("every seat fenced leaves no recommendation at all", () => {
    const context = seatContext([
      { mode: "exclude", scope: "provider", value: "openai" },
      { mode: "exclude", scope: "provider", value: "gogo" },
      { mode: "exclude", scope: "provider", value: "fenced" },
    ]);

    expect(context.eligible).toEqual([]);
    expect(context.preferred_agent).toBeNull();
    expect(context.fallback_agent).toBeNull();
  });

  test("reported biases are limited to the considered seats and the prose is truncated", () => {
    const context = seatContext([
      {
        mode: "exclude",
        reason: "x".repeat(5000),
        scope: "provider",
        value: "fenced",
      },
      { mode: "exclude", scope: "provider", value: "some-other-provider" },
    ]);

    expect(context.active_biases.map((bias) => bias.value)).toEqual(["fenced"]);
    expect((context.active_biases[0]?.reason ?? "").length).toBeLessThan(300);
    expect(context.excluded_by_bias[0]?.bias?.reason?.endsWith("...")).toBe(true);
  });
});

describe("bias expiry", () => {
  test("a future expiry is active and a past expiry is not", () => {
    expect(
      isBiasActive(
        {
          expires_at: "2026-09-08T00:00:00.000Z",
          mode: "exclude",
          scope: "agent",
          value: "a",
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      isBiasActive(
        {
          expires_at: "2026-09-06T00:00:00.000Z",
          mode: "exclude",
          scope: "agent",
          value: "a",
        },
        NOW,
      ),
    ).toBe(false);
  });

  test("a missing or unparseable expiry keeps the fence on (fail closed)", () => {
    expect(isBiasActive({ mode: "exclude", scope: "agent", value: "a" }, NOW)).toBe(true);
    expect(
      isBiasActive({ expires_at: "whenever", mode: "exclude", scope: "agent", value: "a" }, NOW),
    ).toBe(true);
  });
});

describe("daemon payload parsing", () => {
  test("seat names come from the registry array", () => {
    expect(parseAgentNames({ agents: [{ name: "a" }, { name: "b" }, { other: 1 }] })).toEqual([
      "a",
      "b",
    ]);
  });

  test("a shape that is not the registry fails closed", () => {
    expect(() => parseAgentNames({})).toThrow(/no agents array/);
    expect(() => parseAgentNames({ agents: [] })).toThrow(/no seat names/);
  });

  test("bias rows with an unknown scope or mode are dropped, not guessed", () => {
    const biases = parseBiases({
      biases: [
        {
          expires_at: "2026-09-08T00:00:00.000Z",
          mode: "exclude",
          scope: "provider",
          value: "alibaba",
          weight: null,
        },
        { mode: "teleport", scope: "provider", value: "nonsense" },
        { mode: "boost", scope: "galaxy", value: "nonsense" },
      ],
    });

    expect(biases).toEqual([
      {
        expires_at: "2026-09-08T00:00:00.000Z",
        mode: "exclude",
        reason: null,
        scope: "provider",
        value: "alibaba",
        weight: null,
      },
    ]);
  });
});

describe("repo source extraction", () => {
  const sources = readSources(REPO_ROOT);

  test("the phase-header regex comes from the registrar and rejects an ASCII hyphen", () => {
    const literal = extractPhaseHeaderRegex(sources.registrar);
    const probe = probePhaseHeader(literal);

    expect(literal.startsWith("/")).toBe(true);
    expect(probe.em_dash).toBe(true);
    expect(probe.ascii_hyphen).toBe(false);
  });

  test("a registrar that no longer declares parsePhaseHeaders fails loudly", () => {
    expect(() => extractPhaseHeaderRegex("export const nothing = 1;\n")).toThrow(PlanContextError);
  });

  test("heading prefixes are read from the plan parser", () => {
    expect(extractHeadingPrefixes(sources.planParser)).toEqual({
      clear: "## ",
      task: "### ",
    });
  });

  test("a parser with a single heading prefix fails rather than guessing", () => {
    expect(() =>
      extractHeadingPrefixes('if (line.startsWith("### ")) { pending = line; }'),
    ).toThrow(PlanContextError);
  });

  test("task-id patterns and enums are read from the plan-meta schema", () => {
    const rules = extractSchemaRules(sources.planSchema);

    expect(rules.depends_on_id_pattern).toContain("\\d");
    expect(rules.qualified_depends_on_id_pattern).toContain("/");
    expect(rules.task_id_accepts_yaml_number).toBe(true);
    expect(rules.enums.file_scope).toContain("new");
    expect(rules.enums.task_size.length).toBeGreaterThan(0);
    expect(rules.enums.risk_class.length).toBeGreaterThan(0);
  });

  test("the numeric-id warning tracks the schema instead of asserting it", () => {
    const stringOnly = sources.planSchema.replace(
      "z.union([z.string().min(1), z.number()])",
      "z.union([z.string().min(1), z.string()])",
    );

    expect(extractSchemaRules(stringOnly).task_id_accepts_yaml_number).toBe(false);
  });

  test("validator rules are enumerated from the validator source", () => {
    const rules = extractValidatorRules(sources.validator);

    expect(rules).toContain("preferred_agent_unknown");
    expect(rules).toContain("parallel_with_not_reciprocal");
    expect(rules).toContain("file_already_exists");
    expect([...rules].sort((left, right) => left.localeCompare(right))).toEqual(rules);
  });

  test("a validator with no rules fails closed", () => {
    expect(() => extractValidatorRules("export const nothing = 1;\n")).toThrow(/validator moved/);
  });

  test("readSources names the file that is missing", () => {
    expect(() => readSources(mkdtempSync(join(tmpdir(), "plan-context-empty-")))).toThrow(
      /missing source/,
    );
  });
});

const FIXTURE_CHECK_YML = `name: check
jobs:
  check:
    steps:
      - uses: actions/checkout@v4
      - name: typecheck
        run: bun run typecheck
      - name: "test (blocking: sharded)"
        run: |
          IGNORE=(
            --path-ignore-patterns='**/dist/**'
          )
          # a comment mentioning bun test that must not be captured
          for pkg in packages/*/; do
            bun scripts/bun-test-gate.ts "$pkg" "\${IGNORE[@]}" || failed+=("$pkg")
          done
      - name: lint (advisory)
        continue-on-error: true
        run: bun run lint || true
`;

const FIXTURE_PACKAGE_JSON = JSON.stringify({
  scripts: { lint: "eslint .", typecheck: "tsc --build" },
});

describe("gate derivation", () => {
  test("steps carry their blocking status and their expanded bun commands", () => {
    const steps = parseCiSteps(FIXTURE_CHECK_YML);

    expect(steps.map((step) => step.name)).toEqual([
      "",
      "typecheck",
      "test (blocking: sharded)",
      "lint (advisory)",
    ]);
    expect(steps[3]?.blocking).toBe(false);
    expect(steps[2]?.commands).toEqual([
      "bun scripts/bun-test-gate.ts \"$pkg\" --path-ignore-patterns='**/dist/**'",
    ]);
  });

  test("blocking, advisory and shard commands are separated", () => {
    const gates = buildGateContext(FIXTURE_CHECK_YML, FIXTURE_PACKAGE_JSON);

    expect(gates.blocking_commands).toContain("bun run typecheck");
    expect(gates.advisory_commands).toEqual(["bun run lint"]);
    expect(gates.shard_commands).toHaveLength(1);
    expect(gates.package_script_expansions).toEqual({
      lint: "eslint .",
      typecheck: "tsc --build",
    });
  });

  test("a CI workflow with no shard command fails closed", () => {
    const withoutShard = FIXTURE_CHECK_YML.replace(
      /bun scripts\/bun-test-gate\.ts[^\n]*/,
      "echo nothing",
    );

    expect(() => buildGateContext(withoutShard, FIXTURE_PACKAGE_JSON)).toThrow(/the gate moved/);
  });

  test("the live CI workflow yields the sharded gate, not root bun test", () => {
    const sources = readSources(REPO_ROOT);
    const gates = buildGateContext(sources.checkYml, sources.packageJson);

    expect(gates.shard_commands.length).toBeGreaterThan(0);
    for (const command of gates.shard_commands) {
      expect(command).toContain("bun-test-gate.ts");
    }
    expect(gates.blocking_commands).toContain("bun run lint:strict");
    expect(gates.blocking_commands.join("\n")).toContain("check-typecheck-coverage.ts");
    expect(gates.blocking_commands).not.toContain("bun test");
  });
});

describe("plan location", () => {
  test("a directory entry is matched with or without its trailing slash", () => {
    const gitignore = "# comment\n\ndocs/notes/\ndocs/plans/\n!docs/plans/keep.md\n";

    expect(findGitignoreEntry(gitignore, "docs/plans")).toEqual({
      line: 4,
      pattern: "docs/plans/",
    });
    expect(findGitignoreEntry(gitignore, "./docs/notes/")).toEqual({
      line: 3,
      pattern: "docs/notes/",
    });
    expect(findGitignoreEntry(gitignore, "packages")).toBeNull();
  });

  test("comment and negation lines never count as a match", () => {
    expect(findGitignoreEntry("#docs/plans/\n!docs/plans/\n", "docs/plans")).toBeNull();
  });
});

describe("assembled context", () => {
  const sources = readSources(REPO_ROOT);
  const context = buildPlanContext({
    daemon: { base_url: "http://127.0.0.1:1", storage_root: "/tmp/storage" },
    now: NOW,
    planDir: "docs/plans",
    repoRoot: REPO_ROOT,
    seats: seatContext([{ mode: "exclude", scope: "provider", value: "fenced" }]),
    sources,
  });

  test("warnings name the traps that are still live in this repo", () => {
    const joined = context.warnings.join("\n");

    expect(joined).toContain("quote every task id");
    expect(joined).toContain("ASCII hyphen");
    expect(joined).toContain("gitignored");
  });

  test("the markdown render carries the seat pair, the regex and the shard command", () => {
    const markdown = renderMarkdown(context);

    expect(markdown).toContain(context.seats.preferred_agent ?? "NONE");
    expect(markdown).toContain(context.format.phase_header_regex);
    expect(markdown).toContain("bun-test-gate.ts");
    expect(markdown).toContain("do not pin these");
  });

  test("the summary line reports counts, not prose", () => {
    expect(summaryLine(context)).toMatch(/^plan-context: 3 eligible seat\(s\)/);
  });
});

describe("cli shell", () => {
  const defaults = { configDir: "/config", repoRoot: "/repo" };

  test("defaults to json against the given repo", () => {
    expect(parseArgs([], defaults)).toEqual({
      configDir: "/config",
      format: "json",
      planDir: "docs/plans",
      repoRoot: "/repo",
      storageRoot: null,
    });
  });

  test("accepts the documented flags", () => {
    const args = parseArgs(["--format=md", "--plan-dir=docs/elsewhere"], defaults);

    expect(args.format).toBe("md");
    expect(args.planDir).toBe("docs/elsewhere");
  });

  test("an unknown flag or an unknown format is a usage error", () => {
    expect(() => parseArgs(["--nope"], defaults)).toThrow(PlanContextUsageError);
    expect(() => parseArgs(["--format=yaml"], defaults)).toThrow(PlanContextUsageError);
  });

  test("a storage root without port and token is refused rather than guessed", () => {
    const empty = mkdtempSync(join(tmpdir(), "plan-context-root-"));

    expect(() => resolveStorageRoot(empty)).toThrow(/Refusing to fall back/);
  });

  test("a malformed port or empty token is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-context-handle-"));
    writeFileSync(join(dir, "port"), "not-a-port\n");
    writeFileSync(join(dir, "token"), "secret\n");

    expect(() => readDaemonHandle(dir)).toThrow(/invalid daemon port/);

    writeFileSync(join(dir, "port"), "51257\n");
    writeFileSync(join(dir, "token"), "\n");

    expect(() => readDaemonHandle(dir)).toThrow(/empty daemon token/);
  });
});

describe("end to end", () => {
  test("an unusable daemon handle exits 1 without emitting a payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-context-e2e-"));
    writeFileSync(join(dir, "port"), "not-a-port\n");
    writeFileSync(join(dir, "token"), "secret\n");

    const result = Bun.spawnSync({
      cmd: ["bun", SCRIPT, `--storage-root=${dir}`, `--repo=${REPO_ROOT}`],
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("invalid daemon port");
  });

  test("an unknown flag exits 2 with the usage line", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", SCRIPT, "--nope"],
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage: bun scripts/plan-context.ts");
  });
});
