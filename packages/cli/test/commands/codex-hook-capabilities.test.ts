import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadCodexHookCapabilities,
  parseCodexHookCapabilityReport,
  qualifyCodexHookReport,
} from "@src/commands/codex-hook-capabilities.js";

import { expectAsyncThrow } from "./_helpers.js";

const BUILD = "0.153.4";
const PROBE = "isolated-codex-capability-probe";
const MALFORMED = "Codex hook capability report is malformed: ";

type JsonObject = Record<string, unknown>;
type Observation = { exitCode: number; stdout: string; stderr: string };
type Observer = (argv: readonly string[]) => Promise<Observation>;

function commonInput(event: string): JsonObject {
  return {
    session_id: "session-probe",
    transcript_path: null,
    cwd: "/private/tmp/codex-probe/project",
    hook_event_name: event,
    model: "gpt-5.6-sol",
  };
}

function sessionStartInput(source: string): JsonObject {
  return { ...commonInput("SessionStart"), permission_mode: "default", source };
}

function preToolUseInput(toolName: string): JsonObject {
  return {
    ...commonInput("PreToolUse"),
    permission_mode: "default",
    turn_id: "t",
    tool_name: toolName,
    tool_use_id: "u",
    tool_input: {},
  };
}

function preCompactInput(trigger: "auto" | "manual"): JsonObject {
  return { ...commonInput("PreCompact"), turn_id: "t", trigger };
}

function sessionEndInput(): JsonObject {
  return { ...commonInput("SessionEnd"), reason: "other" };
}

function supportedCase(capability: string, scenario: string, input: JsonObject): JsonObject {
  return {
    fixture: {
      surface: "cli",
      build: BUILD,
      capability,
      state: "supported",
      evidence: {
        kind: "live",
        surface: "cli",
        source: PROBE,
        observedAt: "2026-09-12T12:00:00.000Z",
        probeId: `isolated-cli-${capability}-${scenario}`,
      },
      input,
      identity: {
        role: "root",
        sessionId: "session-probe",
        projectCwd: "/private/tmp/codex-probe/project",
        agentId: null,
      },
    },
    reason: null,
    scenario,
  };
}

function startupCase(): JsonObject {
  return supportedCase("SessionStart", "startup", sessionStartInput("startup"));
}

function report(cases: readonly unknown[]): JsonObject {
  return { surface: "cli", build: BUILD, cases, cleanupComplete: true };
}

function without(record: JsonObject, key: string): JsonObject {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as JsonObject;
}

function malformedError(detail: string): Error {
  return new Error(`${MALFORMED}${detail}`);
}

function evidenceOf(row: JsonObject): JsonObject {
  return asObject(asObject(row.fixture).evidence);
}

function identityOf(row: JsonObject): JsonObject {
  return asObject(asObject(row.fixture).identity);
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-cap-")));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function recordingObserver(seen: (readonly string[])[]): Observer {
  return (argv: readonly string[]): Promise<Observation> => {
    seen.push(argv);
    return Promise.resolve({ exitCode: 0, stdout: `codex-cli ${BUILD}\n`, stderr: "" });
  };
}

function fixedObserver(observation: Observation): Observer {
  return (): Promise<Observation> => Promise.resolve(observation);
}

test("parse rule 1: a top-level array or null is rejected", () => {
  expect(() => parseCodexHookCapabilityReport([])).toThrow(
    malformedError("top level must be an object"),
  );
  expect(() => parseCodexHookCapabilityReport(null)).toThrow(
    malformedError("top level must be an object"),
  );
});

test("parse rule 2: an unknown surface is rejected", () => {
  const raw = report([]);
  raw.surface = "web";
  expect(() => parseCodexHookCapabilityReport(raw)).toThrow(malformedError("surface is invalid"));
});

test("parse rule 3: build must be a bounded string or null", () => {
  const blank = report([]);
  blank.build = "   ";
  expect(() => parseCodexHookCapabilityReport(blank)).toThrow(malformedError("build is invalid"));

  const oversized = report([]);
  oversized.build = "x".repeat(8193);
  expect(() => parseCodexHookCapabilityReport(oversized)).toThrow(
    malformedError("build is invalid"),
  );

  const max = report([]);
  max.build = "x".repeat(8192);
  expect(parseCodexHookCapabilityReport(max).build).toBe("x".repeat(8192));

  const nullBuild = report([]);
  nullBuild.build = null;
  expect(parseCodexHookCapabilityReport(nullBuild).build).toBeNull();
});

test("parse rule 4: cases must be an array", () => {
  const raw = report([]);
  raw.cases = {};
  expect(() => parseCodexHookCapabilityReport(raw)).toThrow(
    malformedError("cases must be an array"),
  );
});

test("parse rule 5: cleanupComplete must be a boolean", () => {
  const raw = report([]);
  raw.cleanupComplete = "true";
  expect(() => parseCodexHookCapabilityReport(raw)).toThrow(
    malformedError("cleanupComplete is invalid"),
  );
});

test("parse rule 6: a case without a fixture object is rejected", () => {
  expect(() => parseCodexHookCapabilityReport(report([{}]))).toThrow(
    malformedError("case must contain a fixture"),
  );
});

test("parse rule 7: observedAt must be the canonical toISOString form", () => {
  const trimmed = structuredClone(startupCase());
  evidenceOf(trimmed).observedAt = "2026-09-12T12:00:00Z";
  expect(() => parseCodexHookCapabilityReport(report([trimmed]))).toThrow(
    malformedError("evidence observedAt is invalid"),
  );

  const canonical = structuredClone(startupCase());
  expect(parseCodexHookCapabilityReport(report([canonical])).cases.length).toBe(1);
});

test("parse rule 8: probeId is required but may be null", () => {
  const missing = structuredClone(startupCase());
  asObject(missing.fixture).evidence = without(evidenceOf(missing), "probeId");
  expect(() => parseCodexHookCapabilityReport(report([missing]))).toThrow(
    malformedError("evidence probeId is invalid"),
  );

  const nullProbe = structuredClone(startupCase());
  evidenceOf(nullProbe).probeId = null;
  expect(parseCodexHookCapabilityReport(report([nullProbe])).cases.length).toBe(1);
});

test("parse rule 9: identity role must be a known lineage role", () => {
  const row = structuredClone(startupCase());
  identityOf(row).role = "admin";
  expect(() => parseCodexHookCapabilityReport(report([row]))).toThrow(
    malformedError("case identity role is invalid"),
  );
});

test("parse rule 10: an empty agentId is rejected as child identity", () => {
  const row = structuredClone(startupCase());
  identityOf(row).agentId = "";
  expect(() => parseCodexHookCapabilityReport(report([row]))).toThrow(
    malformedError("case child identity is invalid"),
  );
});

test("parse rule 11: omitted scenario and input produce absent keys", () => {
  const row = without(startupCase(), "scenario");
  row.fixture = without(asObject(row.fixture), "input");
  const parsed = parseCodexHookCapabilityReport(report([row]));
  const first = parsed.cases[0];
  if (!first) {
    throw new Error("expected one parsed case");
  }
  expect(Object.hasOwn(first, "scenario")).toBe(false);
  expect(Object.hasOwn(first.fixture, "input")).toBe(false);
});

test("qualify rule 12: a malformed report yields the parse message without throwing", () => {
  expect(qualifyCodexHookReport([], BUILD)).toEqual({
    hooks: [],
    detail: "Codex hook capability report is malformed: top level must be an object",
  });
});

test("qualify rule 13: a missing observed or report build blocks qualification", () => {
  expect(qualifyCodexHookReport(report([]), undefined)).toEqual({
    hooks: [],
    detail: "capability report and observed Codex CLI builds are required",
  });

  const nullBuild = report([]);
  nullBuild.build = null;
  expect(qualifyCodexHookReport(nullBuild, BUILD)).toEqual({
    hooks: [],
    detail: "capability report and observed Codex CLI builds are required",
  });
});

test("qualify rule 14: an empty case list ends the detail without a separator", () => {
  expect(qualifyCodexHookReport(report([]), BUILD)).toEqual({
    hooks: [],
    detail: "no probe-qualified CLI hook scenarios are available",
  });
});

test("qualify rule 15: duplicate qualifying scenarios deduplicate to one hook", () => {
  const result = qualifyCodexHookReport(report([startupCase(), startupCase()]), BUILD);
  expect(result).toEqual({
    hooks: [{ event: "SessionStart", matcher: "^startup$" }],
    detail: "1 probe-qualified CLI hook scenarios are installed",
  });
});

test("qualify rule 16: omission detail caps at the first three distinct reasons", () => {
  const timeout = structuredClone(startupCase());
  timeout.reason = "probe_timeout";

  const noInput = structuredClone(startupCase());
  noInput.fixture = without(asObject(noInput.fixture), "input");

  const relative = structuredClone(startupCase());
  identityOf(relative).projectCwd = "relative/project";

  const childRole = structuredClone(startupCase());
  identityOf(childRole).role = "child";

  const result = qualifyCodexHookReport(report([timeout, noInput, relative, childRole]), BUILD);
  expect(result).toEqual({
    hooks: [],
    detail:
      "no probe-qualified CLI hook scenarios are available; " +
      "case lacks matching live CLI evidence; " +
      "case lacks validated event input and identity; " +
      "case project identity is not absolute",
  });
});

test("qualify rule 17: a relative project cwd omits the case with its reason", () => {
  const relative = structuredClone(startupCase());
  identityOf(relative).projectCwd = "relative/project";
  const result = qualifyCodexHookReport(report([relative]), BUILD);
  expect(result.hooks).toEqual([]);
  expect(result.detail).toEndWith("; case project identity is not absolute");
});

test("qualify rule 18: PreCompact auto trigger qualifies with an exact matcher", () => {
  const result = qualifyCodexHookReport(
    report([supportedCase("PreCompact", "compact", preCompactInput("auto"))]),
    BUILD,
  );
  expect(result.hooks).toEqual([{ event: "PreCompact", matcher: "^auto$" }]);
});

test("qualify rule 19: SessionEnd other reason qualifies with an exact matcher", () => {
  const result = qualifyCodexHookReport(
    report([supportedCase("SessionEnd", "session_end", sessionEndInput())]),
    BUILD,
  );
  expect(result.hooks).toEqual([{ event: "SessionEnd", matcher: "^other$" }]);
});

test("qualify rule 20: bash scenario matches tool Bash only", () => {
  const ok = qualifyCodexHookReport(
    report([supportedCase("PreToolUse", "bash", preToolUseInput("Bash"))]),
    BUILD,
  );
  expect(ok.hooks).toEqual([{ event: "PreToolUse", matcher: "^Bash$" }]);

  const mismatch = qualifyCodexHookReport(
    report([supportedCase("PreToolUse", "bash", preToolUseInput("exec_command"))]),
    BUILD,
  );
  expect(mismatch.hooks).toEqual([]);
  expect(mismatch.detail).toContain("case scenario does not match its observed source or tool");
});

test("qualify rule 21: exec_command and apply_patch scenarios match their tools", () => {
  const exec = qualifyCodexHookReport(
    report([supportedCase("PreToolUse", "exec_command", preToolUseInput("exec_command"))]),
    BUILD,
  );
  expect(exec.hooks).toEqual([{ event: "PreToolUse", matcher: "^exec_command$" }]);

  const patch = qualifyCodexHookReport(
    report([supportedCase("PreToolUse", "apply_patch", preToolUseInput("apply_patch"))]),
    BUILD,
  );
  expect(patch.hooks).toEqual([{ event: "PreToolUse", matcher: "^apply_patch$" }]);
});

test("qualify rule 22: mcp scenario matcher escapes the observed tool name", () => {
  const result = qualifyCodexHookReport(
    report([supportedCase("PreToolUse", "mcp", preToolUseInput("mcp__fixture__read.v2"))]),
    BUILD,
  );
  expect(result.hooks).toEqual([{ event: "PreToolUse", matcher: "^mcp__fixture__read\\.v2$" }]);
});

test("qualify rule 23: SessionStart clear is outside the matcher allowlist", () => {
  const result = qualifyCodexHookReport(
    report([supportedCase("SessionStart", "clear", sessionStartInput("clear"))]),
    BUILD,
  );
  expect(result.hooks).toEqual([]);
  expect(result.detail).toContain("case scenario does not match its observed source or tool");
});

test("load rule 24: the report path must be absolute and normalized", async () => {
  await withTempDir(async (dir): Promise<void> => {
    const seen: (readonly string[])[] = [];
    await expectAsyncThrow(
      loadCodexHookCapabilities({
        reportPath: "relative.json",
        observeBuild: recordingObserver(seen),
      }),
      "capability report must be an absolute normalized path",
    );
    await expectAsyncThrow(
      loadCodexHookCapabilities({
        reportPath: `${dir}/a/../r.json`,
        observeBuild: recordingObserver(seen),
      }),
      "capability report must be an absolute normalized path",
    );
  });
});

test("load rule 25: a symlinked report path is rejected as non-canonical", async () => {
  await withTempDir(async (dir): Promise<void> => {
    writeFileSync(join(dir, "real.json"), JSON.stringify(report([])));
    symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
    await expectAsyncThrow(
      loadCodexHookCapabilities({
        reportPath: join(dir, "link.json"),
        observeBuild: recordingObserver([]),
      }),
      "capability report path is not canonical",
    );
  });
});

test("load rule 26: a directory is not a regular file", async () => {
  await withTempDir(async (dir): Promise<void> => {
    await expectAsyncThrow(
      loadCodexHookCapabilities({
        reportPath: dir,
        observeBuild: recordingObserver([]),
      }),
      "capability report is not a regular file",
    );
  });
});

test("load rule 27: the report size cap is exactly 262144 bytes", async () => {
  await withTempDir(async (dir): Promise<void> => {
    const tooBig = join(dir, "big.json");
    writeFileSync(tooBig, "x".repeat(262145));
    await expectAsyncThrow(
      loadCodexHookCapabilities({
        reportPath: tooBig,
        observeBuild: recordingObserver([]),
      }),
      "Codex hook capability report is too large",
    );

    const json = JSON.stringify(report([]));
    const padded = `${json}${" ".repeat(262144 - Buffer.byteLength(json))}`;
    expect(Buffer.byteLength(padded, "utf8")).toBe(262144);
    const okPath = join(dir, "ok.json");
    writeFileSync(okPath, padded);
    const loaded = await loadCodexHookCapabilities({
      reportPath: okPath,
      observeBuild: recordingObserver([]),
    });
    expect(loaded.report.build).toBe(BUILD);
  });
});

test("load rule 28: invalid JSON is reported as a malformed report", async () => {
  await withTempDir(async (dir): Promise<void> => {
    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, "{");
    await expectAsyncThrow(
      loadCodexHookCapabilities({
        reportPath: badPath,
        observeBuild: recordingObserver([]),
      }),
      "Codex hook capability report is malformed: JSON is invalid",
    );
  });
});

test("load rule 29: version argv defaults and forwards verbatim", async () => {
  await withTempDir(async (dir): Promise<void> => {
    const reportPath = join(dir, "r.json");
    writeFileSync(reportPath, JSON.stringify(report([])));

    const seen: (readonly string[])[] = [];
    const loaded = await loadCodexHookCapabilities({
      reportPath,
      observeBuild: recordingObserver(seen),
    });
    expect(seen).toEqual([["codex", "--version"]]);
    expect(loaded.observedBuild).toBe(BUILD);

    const pinned: (readonly string[])[] = [];
    const pinnedLoad = await loadCodexHookCapabilities({
      reportPath,
      observeBuild: recordingObserver(pinned),
      versionArgv: ["/opt/codex", "--version"],
    });
    expect(pinned).toEqual([["/opt/codex", "--version"]]);
    expect(pinnedLoad.observedBuild).toBe(BUILD);
  });
});

test("load rule 30: a non-zero version exit fails the observation", async () => {
  await withTempDir(async (dir): Promise<void> => {
    const reportPath = join(dir, "r.json");
    writeFileSync(reportPath, JSON.stringify(report([])));
    await expectAsyncThrow(
      loadCodexHookCapabilities({
        reportPath,
        observeBuild: fixedObserver({ exitCode: 1, stdout: "", stderr: "" }),
      }),
      "Codex --version observation failed",
    );
  });
});

test("load rule 31: the build is read case-insensitively from stderr", async () => {
  await withTempDir(async (dir): Promise<void> => {
    const reportPath = join(dir, "r.json");
    writeFileSync(reportPath, JSON.stringify(report([])));
    const loaded = await loadCodexHookCapabilities({
      reportPath,
      observeBuild: fixedObserver({ exitCode: 0, stdout: "", stderr: "Codex-CLI 0.200.0" }),
    });
    expect(loaded.observedBuild).toBe("0.200.0");
  });
});

test("load rule 32: version output without a codex-cli build is rejected", async () => {
  await withTempDir(async (dir): Promise<void> => {
    const reportPath = join(dir, "r.json");
    writeFileSync(reportPath, JSON.stringify(report([])));
    await expectAsyncThrow(
      loadCodexHookCapabilities({
        reportPath,
        observeBuild: fixedObserver({ exitCode: 0, stdout: "codex 0.1", stderr: "" }),
      }),
      "Codex --version did not report a valid build",
    );
  });
});
