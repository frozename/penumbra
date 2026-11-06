import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  type ArtifactHandle,
  type EnvFailureCode,
  type HookProbeOutcome,
  type PathProbeOutcome,
  PolicyDenialSchema,
  PREFLIGHT_DETAIL_MAX_BYTES,
  PreflightAttributionSchema,
  type PreflightRequest,
  PreflightResultSchema,
  PROBE_PORT_KEYS,
  type ProbeOutcome,
  type ProbePort,
  runPreflight,
  type RuntimeProbeOutcome,
} from "@src/dispatch/capsule/index.js";

const HOME_DIR = "/Users/alice";
const CHECKOUT_PATH = "/Users/alice/src/repo";
const STORAGE_PATH = "/Volumes/scratch/wt-1";
const RUNTIME_VERSION = "1.2.0";

const ARTIFACT_HANDLE: ArtifactHandle = {
  id: "ah-1",
  kind: "log",
  uri: "artifact://test-log-1",
};

function allOkRequest(): PreflightRequest {
  return {
    runtimes: [{ name: "bun", expected: RUNTIME_VERSION }],
    tools: [
      { id: "bun-cli", kind: "cli", command: "bun" },
      { id: "git-cli", kind: "cli", command: "git" },
    ],
    supported_tool_kinds: ["cli"],
    artifact_handles: [ARTIFACT_HANDLE],
    home_dir: HOME_DIR,
  };
}

function requestWithPyMcp(): PreflightRequest {
  const base = allOkRequest();
  return {
    ...base,
    tools: [...base.tools, { id: "py-mcp", kind: "mcp", command: "py" }],
  };
}

interface RecordedCall {
  name: string;
  arg?: unknown;
}

type ProbeOverrides = {
  -readonly [K in keyof ProbePort]?: ProbePort[K];
};

const OK_PROBE: ProbeOutcome = { status: "ok" };
const OK_STORAGE: PathProbeOutcome = { status: "ok", path: STORAGE_PATH };
const OK_CHECKOUT: PathProbeOutcome = { status: "ok", path: CHECKOUT_PATH };
const OK_RUNTIME: RuntimeProbeOutcome = { status: "ok", version: RUNTIME_VERSION };
const OK_HOOK: HookProbeOutcome = { status: "ok", hooks: "installed" };

const resolveOkProbe = (): Promise<ProbeOutcome> => Promise.resolve(OK_PROBE);
const resolveOkStorage = (): Promise<PathProbeOutcome> => Promise.resolve(OK_STORAGE);
const resolveOkCheckout = (): Promise<PathProbeOutcome> => Promise.resolve(OK_CHECKOUT);
const resolveOkRuntime = (): Promise<RuntimeProbeOutcome> => Promise.resolve(OK_RUNTIME);
const resolveOkHook = (): Promise<HookProbeOutcome> => Promise.resolve(OK_HOOK);

function makePort(overrides: ProbeOverrides = {}): {
  port: ProbePort;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record0 = <R>(name: string, impl: () => Promise<R>): (() => Promise<R>) => {
    return (): Promise<R> => {
      calls.push({ name });
      return impl();
    };
  };
  const record1 = <A, R>(name: string, impl: (arg: A) => Promise<R>): ((arg: A) => Promise<R>) => {
    return (arg: A): Promise<R> => {
      calls.push({ name, arg });
      return impl(arg);
    };
  };
  const port: ProbePort = {
    hasBase: record0("hasBase", overrides.hasBase ?? resolveOkProbe),
    hasCode: record0("hasCode", overrides.hasCode ?? resolveOkProbe),
    hasTests: record0("hasTests", overrides.hasTests ?? resolveOkProbe),
    runtime: record1("runtime", overrides.runtime ?? resolveOkRuntime),
    pathTool: record1("pathTool", overrides.pathTool ?? resolveOkProbe),
    storagePath: record0("storagePath", overrides.storagePath ?? resolveOkStorage),
    operatorCheckout: record0("operatorCheckout", overrides.operatorCheckout ?? resolveOkCheckout),
    artifactReadable: record1("artifactReadable", overrides.artifactReadable ?? resolveOkProbe),
    hookStatus: record0("hookStatus", overrides.hookStatus ?? resolveOkHook),
  };
  return { port, calls };
}

const ALL_FAIL_OVERRIDES: Partial<ProbePort> = {
  hasBase: () => Promise.resolve({ status: "fail", detail: "no base" }),
  hasCode: () => Promise.resolve({ status: "fail", detail: "no code" }),
  hasTests: () => Promise.resolve({ status: "fail", detail: "no tests" }),
  runtime: () => Promise.resolve({ status: "fail", detail: "bun missing" }),
  pathTool: () => Promise.resolve({ status: "fail", detail: "not on PATH" }),
  storagePath: () => Promise.resolve({ status: "fail", detail: "io error" }),
  operatorCheckout: () => Promise.resolve({ status: "fail", detail: "io error" }),
  artifactReadable: () => Promise.resolve({ status: "fail", detail: "unreadable" }),
  hookStatus: () => Promise.resolve({ status: "unknown", detail: "?" }),
};

const ALL_FAIL_EXPECTED_CODES = [
  "base_missing",
  "code_missing",
  "tests_missing",
  "runtime_mismatch",
  "path_missing_tool",
  "path_missing_tool",
  "path_missing_tool",
  "tool_unsupported",
  "storage_not_isolated",
  "storage_not_isolated",
  "artifact_unreadable",
  "hook_unknown",
] as const;

interface SingleFailureRow {
  label: string;
  overrides: Partial<ProbePort>;
  code: EnvFailureCode;
  probe: string;
  subject?: string;
}

const SINGLE_FAILURE_ROWS: SingleFailureRow[] = [
  {
    label: "hasBase",
    overrides: { hasBase: () => Promise.resolve({ status: "fail", detail: "no base" }) },
    code: "base_missing",
    probe: "hasBase",
  },
  {
    label: "hasCode",
    overrides: { hasCode: () => Promise.resolve({ status: "fail", detail: "no code" }) },
    code: "code_missing",
    probe: "hasCode",
  },
  {
    label: "hasTests",
    overrides: { hasTests: () => Promise.resolve({ status: "fail", detail: "no tests" }) },
    code: "tests_missing",
    probe: "hasTests",
  },
  {
    label: "runtime",
    overrides: { runtime: () => Promise.resolve({ status: "fail", detail: "bun missing" }) },
    code: "runtime_mismatch",
    probe: "runtime",
    subject: "bun",
  },
  {
    label: "pathTool",
    overrides: {
      pathTool: (name) =>
        Promise.resolve(name === "git" ? { status: "fail", detail: "not on PATH" } : OK_PROBE),
    },
    code: "path_missing_tool",
    probe: "pathTool",
    subject: "git-cli",
  },
  {
    label: "storagePath",
    overrides: { storagePath: () => Promise.resolve({ status: "fail", detail: "io error" }) },
    code: "storage_not_isolated",
    probe: "storagePath",
  },
  {
    label: "operatorCheckout",
    overrides: { operatorCheckout: () => Promise.resolve({ status: "fail", detail: "io error" }) },
    code: "storage_not_isolated",
    probe: "operatorCheckout",
  },
  {
    label: "artifactReadable",
    overrides: { artifactReadable: () => Promise.resolve({ status: "fail", detail: "gone" }) },
    code: "artifact_unreadable",
    probe: "artifactReadable",
    subject: "ah-1",
  },
  {
    label: "hookStatus",
    overrides: { hookStatus: () => Promise.resolve({ status: "unknown", detail: "?" }) },
    code: "hook_unknown",
    probe: "hookStatus",
  },
];

const RUNTIME_BAD_ROWS: { label: string; outcome: RuntimeProbeOutcome }[] = [
  { label: "ok with a different version", outcome: { status: "ok", version: "1.1.0" } },
  { label: "fail", outcome: { status: "fail", detail: "bun not found" } },
  { label: "unknown", outcome: { status: "unknown", detail: "?" } },
];

const PATH_TOOL_BAD_ROWS: { label: string; outcome: ProbeOutcome }[] = [
  { label: "fail", outcome: { status: "fail", detail: "not on PATH" } },
  { label: "unknown", outcome: { status: "unknown", detail: "?" } },
];

const ARTIFACT_BAD_ROWS: { label: string; outcome: ProbeOutcome }[] = [
  { label: "fail", outcome: { status: "fail", detail: "unreadable" } },
  { label: "unknown", outcome: { status: "unknown", detail: "?" } },
];

interface StorageBadRow {
  label: string;
  storagePath?: PathProbeOutcome;
  operatorCheckout?: PathProbeOutcome;
  probe: string;
}

const STORAGE_BAD_ROWS: StorageBadRow[] = [
  {
    label: "storage equals checkout",
    storagePath: { status: "ok", path: CHECKOUT_PATH },
    probe: "storagePath",
  },
  {
    label: "storage under checkout",
    storagePath: { status: "ok", path: `${CHECKOUT_PATH}/.tmp` },
    probe: "storagePath",
  },
  {
    label: "storage equals home",
    storagePath: { status: "ok", path: HOME_DIR },
    probe: "storagePath",
  },
  {
    label: "storage under home",
    storagePath: { status: "ok", path: `${HOME_DIR}/tmp` },
    probe: "storagePath",
  },
  {
    label: "storage home with trailing slash",
    storagePath: { status: "ok", path: `${HOME_DIR}/` },
    probe: "storagePath",
  },
  {
    label: "storagePath fail",
    storagePath: { status: "fail", detail: "io error" },
    probe: "storagePath",
  },
  {
    label: "storagePath unknown",
    storagePath: { status: "unknown", detail: "?" },
    probe: "storagePath",
  },
  {
    label: "operatorCheckout fail",
    operatorCheckout: { status: "fail", detail: "io error" },
    probe: "operatorCheckout",
  },
  {
    label: "operatorCheckout unknown",
    operatorCheckout: { status: "unknown", detail: "?" },
    probe: "operatorCheckout",
  },
];

const HOOK_STATUS_ROWS: {
  label: string;
  outcome: HookProbeOutcome;
  code: EnvFailureCode | null;
}[] = [
  { label: "missing", outcome: { status: "ok", hooks: "missing" }, code: "hook_missing" },
  { label: "empty", outcome: { status: "ok", hooks: "empty" }, code: "hook_missing" },
  { label: "installed", outcome: { status: "ok", hooks: "installed" }, code: null },
  { label: "not_configured", outcome: { status: "ok", hooks: "not_configured" }, code: null },
];

describe("runPreflight", () => {
  test("returns ready with no failures when every probe is ok", async () => {
    const { port } = makePort();
    const result = await runPreflight(port, allOkRequest());
    expect(result).toEqual({ ready: true, failures: [] });
  });

  test.each(SINGLE_FAILURE_ROWS)(
    "only $label failing yields exactly one $code failure",
    async ({ overrides, code, probe, subject }) => {
      const { port } = makePort(overrides);
      const result = await runPreflight(port, allOkRequest());
      expect(result.ready).toBe(false);
      expect(result.failures.map((f) => f.code)).toEqual([code]);
      const failure = result.failures[0]!;
      expect(failure.probe).toBe(probe);
      if (subject === undefined) {
        expect(failure.subject).toBeUndefined();
      } else {
        expect(failure.subject).toBe(subject);
      }
    },
  );

  test.each(RUNTIME_BAD_ROWS)("runtime $label yields runtime_mismatch", async ({ outcome }) => {
    const { port } = makePort({ runtime: () => Promise.resolve(outcome) });
    const result = await runPreflight(port, allOkRequest());
    expect(result.failures.map((f) => f.code)).toEqual(["runtime_mismatch"]);
    expect(result.failures[0]!.probe).toBe("runtime");
    expect(result.failures[0]!.subject).toBe("bun");
  });

  test.each(PATH_TOOL_BAD_ROWS)("pathTool $label yields path_missing_tool", async ({ outcome }) => {
    const { port } = makePort({
      pathTool: (name) => Promise.resolve(name === "git" ? outcome : OK_PROBE),
    });
    const result = await runPreflight(port, allOkRequest());
    expect(result.failures.map((f) => f.code)).toEqual(["path_missing_tool"]);
    expect(result.failures[0]!.subject).toBe("git-cli");
  });

  test("a tool kind outside supported_tool_kinds yields tool_unsupported", async () => {
    const { port, calls } = makePort();
    const result = await runPreflight(port, requestWithPyMcp());
    expect(result.failures.map((f) => f.code)).toEqual(["tool_unsupported"]);
    expect(result.failures[0]!.subject).toBe("py-mcp");
    expect(calls.filter((call) => call.name === "pathTool").map((call) => call.arg)).toEqual([
      "bun",
      "git",
      "py",
    ]);
  });

  test.each(STORAGE_BAD_ROWS)("storage $label yields storage_not_isolated", async (row) => {
    const overrides: ProbeOverrides = {};
    if (row.storagePath !== undefined) {
      const outcome = row.storagePath;
      overrides.storagePath = (): Promise<PathProbeOutcome> => Promise.resolve(outcome);
    }
    if (row.operatorCheckout !== undefined) {
      const outcome = row.operatorCheckout;
      overrides.operatorCheckout = (): Promise<PathProbeOutcome> => Promise.resolve(outcome);
    }
    const { port } = makePort(overrides);
    const result = await runPreflight(port, allOkRequest());
    expect(result.failures.map((f) => f.code)).toEqual(["storage_not_isolated"]);
    expect(result.failures[0]!.probe).toBe(row.probe);
  });

  test("storage under a sibling prefix of home is not flagged", async () => {
    const { port } = makePort({
      storagePath: () => Promise.resolve({ status: "ok", path: "/Users/alice2/x" }),
    });
    const result = await runPreflight(port, allOkRequest());
    expect(result).toEqual({ ready: true, failures: [] });
  });

  test.each(ARTIFACT_BAD_ROWS)(
    "artifactReadable $label yields artifact_unreadable",
    async ({ outcome }) => {
      const { port } = makePort({ artifactReadable: () => Promise.resolve(outcome) });
      const result = await runPreflight(port, allOkRequest());
      expect(result.failures.map((f) => f.code)).toEqual(["artifact_unreadable"]);
      expect(result.failures[0]!.probe).toBe("artifactReadable");
      expect(result.failures[0]!.subject).toBe("ah-1");
    },
  );

  test.each(HOOK_STATUS_ROWS)("hook status $label maps to $code", async ({ outcome, code }) => {
    const { port } = makePort({ hookStatus: () => Promise.resolve(outcome) });
    const result = await runPreflight(port, allOkRequest());
    if (code === null) {
      expect(result).toEqual({ ready: true, failures: [] });
      return;
    }
    expect(result.failures.map((f) => f.code)).toEqual([code]);
    expect(result.failures[0]!.probe).toBe("hookStatus");
  });
});

describe("runPreflight failure aggregation", () => {
  test("reports every failure in request order", async () => {
    const { port } = makePort(ALL_FAIL_OVERRIDES);
    const result = await runPreflight(port, requestWithPyMcp());
    expect(result.ready).toBe(false);
    expect(result.failures.map((f) => f.code)).toEqual([...ALL_FAIL_EXPECTED_CODES]);
    expect(result.failures.map((f) => f.subject)).toEqual([
      undefined,
      undefined,
      undefined,
      "bun",
      "bun-cli",
      "git-cli",
      "py-mcp",
      "py-mcp",
      undefined,
      undefined,
      "ah-1",
      undefined,
    ]);
    expect(
      result.failures.filter((f) => f.code === "storage_not_isolated").map((f) => f.probe),
    ).toEqual(["storagePath", "operatorCheckout"]);
  });

  test("calls each probe exactly once per request item", async () => {
    const { port, calls } = makePort(ALL_FAIL_OVERRIDES);
    await runPreflight(port, requestWithPyMcp());
    const count = (name: string): number => calls.filter((call) => call.name === name).length;
    for (const name of [
      "hasBase",
      "hasCode",
      "hasTests",
      "storagePath",
      "operatorCheckout",
      "hookStatus",
    ]) {
      expect(count(name)).toBe(1);
    }
    expect(count("runtime")).toBe(1);
    expect(calls.filter((call) => call.name === "runtime").map((call) => call.arg)).toEqual([
      "bun",
    ]);
    expect(calls.filter((call) => call.name === "pathTool").map((call) => call.arg)).toEqual([
      "bun",
      "git",
      "py",
    ]);
    expect(count("artifactReadable")).toBe(1);
    expect(calls.find((call) => call.name === "artifactReadable")?.arg).toEqual(ARTIFACT_HANDLE);
  });

  test("a probe that rejects is treated as unknown", async () => {
    const { port } = makePort({ hasCode: () => Promise.reject(new Error("boom")) });
    const result = await runPreflight(port, allOkRequest());
    expect(result.failures.map((f) => f.code)).toEqual(["code_missing"]);
    expect(result.failures[0]!.attribution).toBe("environment");
  });

  test("a probe that throws synchronously is treated as unknown", async () => {
    const { port } = makePort({
      hasTests: () => {
        throw new Error("boom");
      },
    });
    const result = await runPreflight(port, allOkRequest());
    expect(result.failures.map((f) => f.code)).toEqual(["tests_missing"]);
    expect(result.failures[0]!.attribution).toBe("environment");
  });
});

describe("preflight attribution", () => {
  test("every failure in the all-fail result is an environment failure", async () => {
    const { port } = makePort(ALL_FAIL_OVERRIDES);
    const result = await runPreflight(port, requestWithPyMcp());
    expect(result.failures).toHaveLength(ALL_FAIL_EXPECTED_CODES.length);
    for (const failure of result.failures) {
      expect(failure.attribution).toBe("environment");
      expect(failure.credit_attempt).toBe(false);
    }
    expect(PreflightResultSchema.safeParse(result).success).toBe(true);
  });

  test("preflight attribution is exactly environment or policy", () => {
    expect(PreflightAttributionSchema.options).toEqual(["environment", "policy"]);
  });
});

describe("hook status failures", () => {
  test("an unknown hook status is a failure, not a pass", async () => {
    const { port } = makePort({
      hookStatus: () => Promise.resolve({ status: "unknown", detail: "?" }),
    });
    const result = await runPreflight(port, allOkRequest());
    expect(result.ready).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.code).toBe("hook_unknown");
    expect(result.failures[0]!.attribution).toBe("environment");
  });

  test("hook_missing carries the provision_via_217 remediation", async () => {
    const { port } = makePort({
      hookStatus: () => Promise.resolve({ status: "ok", hooks: "missing" }),
    });
    const result = await runPreflight(port, allOkRequest());
    expect(result.failures.map((f) => f.code)).toEqual(["hook_missing"]);
    const failure = result.failures[0]!;
    expect(failure.attribution).toBe("environment");
    if (failure.attribution === "environment") {
      expect(failure.remediation).toBe("provision_via_217");
    }
  });
});

describe("probe port surface", () => {
  test("ProbePort exposes exactly the nine read-only probe members", () => {
    expect(PROBE_PORT_KEYS).toEqual([
      "hasBase",
      "hasCode",
      "hasTests",
      "runtime",
      "pathTool",
      "storagePath",
      "operatorCheckout",
      "artifactReadable",
      "hookStatus",
    ]);
    expect(PROBE_PORT_KEYS).not.toContain("install");
    expect(PROBE_PORT_KEYS).not.toContain("exec");
    expect(PROBE_PORT_KEYS).not.toContain("run");
    const installerPin: ProbePort = {
      ...makePort().port,
      // @ts-expect-error ProbePort has no installer member
      install: (): Promise<void> => Promise.resolve(),
    };
    void installerPin;
  });

  test("preflight source stays pure: no process, node imports, or git-hooks", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../../src/dispatch/capsule/preflight.ts"),
      "utf8",
    );
    expect(source).not.toContain("child_process");
    expect(source).not.toContain('from "node:');
    expect(source).not.toContain("git-hooks");
  });

  test("the preflight seam re-exports the hook status type-only", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../../src/dispatch/preflight-primitives.ts"),
      "utf8",
    );
    const hooksLine = source.split("\n").find((line) => line.includes("git-hooks"));
    expect(hooksLine?.startsWith("export type {")).toBe(true);
  });
});

describe("policy denials", () => {
  test("a denied hasCode probe yields a policy denial", async () => {
    const { port, calls } = makePort({
      hasCode: () => Promise.resolve({ status: "denied", detail: "EACCES" }),
    });
    const result = await runPreflight(port, allOkRequest());
    expect(result.ready).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({
      attribution: "policy",
      code: "permission_denied",
      credit_attempt: false,
      retryable: false,
      probe: "hasCode",
      detail: "EACCES",
    });
    const failure = result.failures[0]!;
    expect(failure).not.toHaveProperty("retry_with");
    expect(failure).not.toHaveProperty("bypass");
    expect(failure).not.toHaveProperty("grant");
    expect(calls.filter((call) => call.name === "hasCode")).toHaveLength(1);
  });

  test("a denied hookStatus probe yields a policy denial", async () => {
    const { port, calls } = makePort({
      hookStatus: () => Promise.resolve({ status: "denied", detail: "EPERM" }),
    });
    const result = await runPreflight(port, allOkRequest());
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({
      attribution: "policy",
      code: "permission_denied",
      credit_attempt: false,
      retryable: false,
      probe: "hookStatus",
      detail: "EPERM",
    });
    expect(calls.filter((call) => call.name === "hookStatus")).toHaveLength(1);
  });

  test("PolicyDenialSchema rejects extra keys", () => {
    const valid = {
      attribution: "policy",
      code: "permission_denied",
      credit_attempt: false,
      retryable: false,
      probe: "hasCode",
      detail: "EACCES",
    };
    expect(PolicyDenialSchema.safeParse(valid).success).toBe(true);
    expect(PolicyDenialSchema.safeParse({ ...valid, retry_with: "sudo" }).success).toBe(false);
  });
});

describe("diagnostic details", () => {
  test("secrets and home paths are redacted from failure details", async () => {
    const { port } = makePort({
      hasBase: () =>
        Promise.resolve({
          status: "fail",
          detail: `token ghp_${"A".repeat(36)} at /Users/alice/secret/key.txt`,
        }),
    });
    const result = await runPreflight(port, allOkRequest());
    expect(result.failures).toHaveLength(1);
    const detail = result.failures[0]!.detail;
    expect(detail).not.toContain("ghp_");
    expect(detail).not.toContain("/Users/alice");
    expect(detail).toContain("[REDACTED");
    expect(detail).toContain("~/secret/key.txt");
  });

  test("failure details are bounded to PREFLIGHT_DETAIL_MAX_BYTES", async () => {
    const { port } = makePort({
      hasBase: () => Promise.resolve({ status: "fail", detail: "é".repeat(5000) }),
    });
    const result = await runPreflight(port, allOkRequest());
    expect(result.failures).toHaveLength(1);
    const detail = result.failures[0]!.detail;
    expect(new TextEncoder().encode(detail).length).toBeLessThanOrEqual(PREFLIGHT_DETAIL_MAX_BYTES);
  });
});
