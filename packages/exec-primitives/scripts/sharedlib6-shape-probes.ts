/**
 * sharedlib6-shape-probes.ts — the SHAPE self-test. Each probe edits one
 * bound field of a clone of the committed evidence; SHAPE over the clone must
 * report a NEW reason matching the probe's pattern. A probe that stays green
 * means that field is no longer bound to a fresh measurement, so SHAPE fails
 * closed on the committed pair too. A probe whose target is missing from the
 * evidence also fails: the binding it pins would have nothing to bind.
 */

type Ev = Record<string, unknown>;

export interface ShapeProbe {
  name: string;
  /** Pattern a new SHAPE reason must match once the edit is applied. */
  expect: RegExp;
  /** Applies the edit in place; false when the target field is missing. */
  mutate: (ev: Ev) => boolean;
  /** Edits the .md instead; null when the target text is missing. */
  mutateMd?: (md: string) => string | null;
}

export interface ProbeOutcome {
  name: string;
  status: "detected" | "undetected" | "target missing";
}

function obj(v: unknown): Ev | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Ev) : undefined;
}

/** Walks object keys and array indexes; undefined when any hop is missing. */
function at(ev: Ev, path: (string | number)[]): unknown {
  let cur: unknown = ev;
  for (const hop of path) {
    if (typeof hop === "number") {
      cur = Array.isArray(cur) ? cur[hop] : undefined;
    } else {
      cur = obj(cur)?.[hop];
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Sets `key` on the container at `path`; false when the old value is absent. */
function edit(
  ev: Ev,
  path: (string | number)[],
  key: string,
  next: (old: unknown) => unknown,
): boolean {
  const holder = obj(at(ev, path));
  if (holder === undefined || !(key in holder)) return false;
  holder[key] = next(holder[key]);
  return true;
}

const bump = (old: unknown): unknown => (typeof old === "number" ? old + 1 : 1);
const flip = (old: unknown): unknown => (old === "PASS" ? "FAIL" : "PASS");

function measurementProbe(
  label: string,
  gate: number,
  path: string[],
  key: string,
  next: (old: unknown) => unknown,
): ShapeProbe {
  return {
    name: `gates[${label}].measurements.${[...path, key].join(".")}`,
    expect: new RegExp(`gates\\[${label}\\]\\.measurements`),
    mutate: (ev) => edit(ev, ["gates", gate, "measurements", ...path], key, next),
  };
}

function perFileProbe(index: number, key: string): ShapeProbe {
  return {
    name: `parity.per_file[${String(index)}].${key}`,
    expect: new RegExp(`parity\\.per_file\\[${String(index)}\\]\\.${key}`),
    mutate: (ev) => edit(ev, ["parity", "per_file", index], key, bump),
  };
}

function dropOpenFinding(id: string): ShapeProbe {
  return {
    name: `open_findings without ${id}`,
    expect: new RegExp(`open_findings missing required entry ${id}`),
    mutate: (ev): boolean => {
      const list = ev["open_findings"];
      if (!Array.isArray(list)) return false;
      const kept = list.filter((f) => obj(f)?.["id"] !== id);
      if (kept.length === list.length) return false;
      ev["open_findings"] = kept;
      return true;
    },
  };
}

function openFindingEdit(
  id: string,
  name: string,
  expect: RegExp,
  apply: (f: Ev) => boolean,
): ShapeProbe {
  return {
    name,
    expect,
    mutate: (ev): boolean => {
      const list = ev["open_findings"];
      const found = Array.isArray(list) ? list.map(obj).find((f) => f?.["id"] === id) : undefined;
      return found === undefined ? false : apply(found);
    },
  };
}

/** A .md-only probe: the .json stays as committed. */
function mdProbe(name: string, re: RegExp, edit: (m: RegExpExecArray) => string): ShapeProbe {
  return {
    name,
    expect: /evidence \.md differs from the render of the committed \.json/,
    mutate: () => true,
    mutateMd: (md): string | null => {
      const m = re.exec(md);
      return m === null ? null : md.slice(0, m.index) + edit(m) + md.slice(m.index + m[0].length);
    },
  };
}

function setProbe(
  name: string,
  expect: RegExp,
  path: (string | number)[],
  key: string,
  next: (old: unknown) => unknown,
): ShapeProbe {
  return { name, expect, mutate: (ev) => edit(ev, path, key, next) };
}

/** Probes for the fields the regeneration diff and the explicit rules bind. */
const BINDING_PROBES: ShapeProbe[] = [
  mdProbe(
    ".md per-file parity cell",
    /(\| `packages\/agentchat\/test\/adapters\/cli-spawn\.test\.ts` \| \d+ \| \d+ \| )(\d+)/,
    (m) => `${m[1] ?? ""}${String(Number(m[2]) + 75)}`,
  ),
  mdProbe(".md RED/GREEN cell", /(\| \[B3\] \| [^|]+\| )(\d+)( failing)/, (m) =>
    [m[1], String(Number(m[2]) + 27), m[3]].join(""),
  ),
  {
    name: "honesty carries an extra key",
    expect: /honesty/,
    mutate: (ev): boolean => {
      const h = obj(ev["honesty"]);
      if (h === undefined) return false;
      h["summary"] = "no claim";
      return true;
    },
  },
  {
    name: "claim phrase inside honesty",
    expect: /evidence json carries claim "qualified" at honesty/,
    mutate: (ev): boolean => {
      const h = obj(ev["honesty"]);
      if (h === undefined) return false;
      h["summary"] = "the library is qualified and ready";
      return true;
    },
  },
  setProbe(
    "t7_overshoot_bytes = 1 (below one read)",
    /gates\[L4\]\.measurements\.t7_overshoot_bytes/,
    ["gates", 3, "measurements"],
    "t7_overshoot_bytes",
    () => 1,
  ),
  setProbe(
    "t7_overshoot_bytes in the domain but more than one read from this run's marker (p13)",
    /t7_overshoot_bytes \d+ is more than one 65536-byte read from this run's t7-overshoot marker/,
    ["gates", 3, "measurements"],
    "t7_overshoot_bytes",
    (old) => (typeof old === "number" && old <= 458_752 ? 917_504 : 65_536),
  ),
  setProbe(
    "mutations[3].errors within 0..failing but not this run's count (p13)",
    /mutations\[3\]\.errors evidence \d+ != mutation-loop \d+/,
    ["mutations", 3],
    "errors",
    (old) => (old === 0 ? 1 : 0),
  ),
  setProbe(
    "mutations[3].errors not exempt from the regeneration diff (p13)",
    /evidence\.mutations\[3\]\.errors \d+ != regenerated \d+/,
    ["mutations", 3],
    "errors",
    (old) => (old === 0 ? 1 : 0),
  ),
  setProbe(
    "head_sha names an older commit whose code tree differs from HEAD",
    /head_sha e634f10db87e0f36a14338356e1887cfbf58c83d does not carry HEAD's code tree/,
    [],
    "head_sha",
    () => "e634f10db87e0f36a14338356e1887cfbf58c83d",
  ),
  setProbe(
    "t7_overshoot_bytes = 999999999 (past the producer)",
    /gates\[L4\]\.measurements\.t7_overshoot_bytes/,
    ["gates", 3, "measurements"],
    "t7_overshoot_bytes",
    () => 999_999_999,
  ),
  {
    name: "gates[L1].evidence[0] inferred without would_confirm",
    expect: /L1 evidence\[0\] is inferred without would_confirm/,
    mutate: (ev) => edit(ev, ["gates", 0, "evidence", 0], "status", () => "inferred"),
  },
  setProbe(
    "deviations emptied",
    /deviations\[\] missing required rule/,
    [],
    "deviations",
    () => [],
  ),
  setProbe(
    "parity.per_file[0].adaptations emptied",
    /parity\.per_file\[0\]\.adaptations/,
    ["parity", "per_file", 0],
    "adaptations",
    () => [],
  ),
  setProbe(
    "audit_allowlist_entries emptied",
    /audit_allowlist_entries/,
    [],
    "audit_allowlist_entries",
    () => [],
  ),
  setProbe(
    "audit_allowlist_entries[0] reclassified",
    /audit_allowlist_entries/,
    ["audit_allowlist_entries", 0],
    "classification",
    () => "pre-approved",
  ),
  setProbe("blockers.B8 resolved", /B8/, ["blockers", "B8"], "status", () => "resolved"),
  setProbe(
    "blockers.B3 evidence text",
    /blockers\.B3\.evidence/,
    ["blockers", "B3"],
    "evidence",
    (old) => `${String(old)} (edited)`,
  ),
  setProbe(
    "count inside an L1 claim",
    /gates\[0\]\.evidence\[2\]\.claim/,
    ["gates", 0, "evidence", 2],
    "claim",
    (old) => String(old).replace(/lines=\d+/, "lines=1"),
  ),
  setProbe(
    "count appended to an L4 claim",
    /gates\[3\]\.evidence\[0\]\.claim/,
    ["gates", 3, "evidence", 0],
    "claim",
    (old) => `${String(old)} (suite 999/0)`,
  ),
  setProbe(
    "section2.verdict.rows[0].origin_pass",
    /section2\.verdict\.rows\[0\]\.origin_pass/,
    ["section2", "verdict", "rows", 0],
    "origin_pass",
    bump,
  ),
  setProbe(
    "red_green.tag_passes.B3",
    /red_green\.tag_passes\.B3/,
    ["red_green", "tag_passes"],
    "B3",
    bump,
  ),
  setProbe(
    "open_findings[0].finding text",
    /open_findings\[0\]\.finding/,
    ["open_findings", 0],
    "finding",
    (old) => `${String(old)} (edited)`,
  ),
  setProbe(
    "check_steps[0].log",
    /check_steps\[0\]\.log/,
    ["check_steps", 0],
    "log",
    () => "check-logs/elsewhere.log",
  ),
];

/** Keeps every entry of the record at `key` except `drop`. */
function withoutKey(old: unknown, drop: string): Ev {
  return Object.fromEntries(Object.entries(obj(old) ?? {}).filter(([k]) => k !== drop));
}

function appendToFinding(name: string, text: string, expect: RegExp): ShapeProbe {
  return setProbe(
    name,
    expect,
    ["open_findings", 0],
    "finding",
    (old) => `${String(old)}; ${text}`,
  );
}

/** Probes for the environment records (sharedlib6-shape-env.ts) and the
 * separator variants of the claim phrases. */
const ENVIRONMENT_PROBES: ShapeProbe[] = [
  setProbe("toolchain.bun fabricated", /toolchain\.bun/, ["toolchain"], "bun", () => "1.2.0"),
  setProbe(
    "toolchain.typescript fabricated",
    /toolchain\.typescript/,
    ["toolchain"],
    "typescript",
    () => "5.0.0",
  ),
  {
    name: "toolchain carries an extra key",
    expect: /toolchain keys/,
    mutate: (ev): boolean => {
      const t = obj(ev["toolchain"]);
      if (t === undefined) return false;
      t["note"] = "recorded elsewhere";
      return true;
    },
  },
  setProbe(
    "poison_layer emptied",
    /poison_layer must be a non-empty/,
    [],
    "poison_layer",
    () => [],
  ),
  setProbe(
    "poison_layer without @penumbra/core",
    /poison_layer lacks/,
    [],
    "poison_layer",
    (old) => (Array.isArray(old) ? (old as unknown[]).filter((n) => n !== "@penumbra/core") : old),
  ),
  setProbe(
    "poison_layer names a foreign package",
    /poison_layer names non-workspace/,
    [],
    "poison_layer",
    (old) => [
      ...(Array.isArray(old) ? (old as unknown[]) : []),
      "@penumbra/not-a-workspace-package",
    ],
  ),
  setProbe(
    "artifact_sha256 carries an extra file",
    /artifact_sha256 keys/,
    [],
    "artifact_sha256",
    (old) => ({
      ...obj(old),
      "extra.json": "0".repeat(64),
    }),
  ),
  setProbe("artifact_sha256 drops a file", /artifact_sha256 keys/, [], "artifact_sha256", (old) =>
    withoutKey(old, "measurements.json"),
  ),
  setProbe(
    "artifact_sha256 value is not a digest",
    /artifact_sha256\.mutations\.json .* is not a sha256/,
    ["artifact_sha256"],
    "mutations.json",
    () => "not-a-digest",
  ),
  setProbe(
    "generated_at malformed",
    /generated_at .* is not an ISO-8601/,
    [],
    "generated_at",
    () => "yesterday",
  ),
  setProbe(
    "generated_at in the future",
    /generated_at .* is in the future/,
    [],
    "generated_at",
    () => "2099-01-01T00:00:00.000Z",
  ),
  setProbe(
    "generated_at before the head_sha commit",
    /precedes the head_sha commit/,
    [],
    "generated_at",
    () => "2020-01-01T00:00:00.000Z",
  ),
  appendToFinding(
    "space-separated claim phrase",
    "dual consumer parity demonstrated",
    /evidence json carries claim "dual-consumer parity"/,
  ),
  appendToFinding(
    "hyphen-separated claim phrase",
    "home-chosen by the operator",
    /evidence json carries claim "home chosen"/,
  ),
];

export const SHAPE_PROBES: ShapeProbe[] = [
  perFileProbe(0, "passed"),
  perFileProbe(1, "ported"),
  perFileProbe(2, "baseline_tests"),
  perFileProbe(5, "not_portable"),
  measurementProbe("L1", 0, [], "lines", bump),
  measurementProbe("L2", 1, ["consumers", "penumbra-host"], "poison_pass", () => 7),
  measurementProbe("L2", 1, ["consumers", "infra-host"], "all_green", (old) => old !== true),
  measurementProbe("L3", 2, [], "penumbra", flip),
  measurementProbe("L4", 3, ["suite"], "fail", () => 5),
  measurementProbe("L4", 3, [], "mutations_detected", (old) =>
    typeof old === "number" ? old - 1 : 0,
  ),
  measurementProbe("L4", 3, [], "t7_overshoot_bytes", () => 0),
  measurementProbe("L5", 4, [], "root_lint_exit", bump),
  measurementProbe("L6", 5, [], "control_flow_entries", () => 2),
  measurementProbe("L6", 5, [], "allowlist_entries", bump),
  {
    name: "candidate.lines",
    expect: /candidate\.lines/,
    mutate: (ev) => edit(ev, ["candidate"], "lines", () => 1),
  },
  {
    name: "candidate.runtime_imports",
    expect: /candidate\.runtime_imports/,
    mutate: (ev) => edit(ev, ["candidate"], "runtime_imports", bump),
  },
  {
    name: "mutations[3].fail",
    expect: /mutations\[3\]\.fail evidence/,
    mutate: (ev) => edit(ev, ["mutations", 3], "fail", bump),
  },
  {
    name: "mutations[5].failing_tests",
    expect: /mutations\[5\]\.failing_tests evidence/,
    mutate: (ev) =>
      edit(ev, ["mutations", 5], "failing_tests", (old): unknown[] =>
        Array.isArray(old) ? (old as unknown[]).slice(1) : [],
      ),
  },
  {
    name: "mutations[5].errors beyond the failing count",
    expect: /mutations\[5\]\.errors evidence 99 outside/,
    mutate: (ev) => edit(ev, ["mutations", 5], "errors", () => 99),
  },
  dropOpenFinding("t10-limits"),
  dropOpenFinding("b10-logger-stdio-acp-client"),
  openFindingEdit(
    "root-lint-qualification-errors",
    "open_findings root-lint measured.errors",
    /root-lint-qualification-errors measured/,
    (f) => edit(f, [], "measured", (old) => ({ ...obj(old), errors: bump(obj(old)?.["errors"]) })),
  ),
  openFindingEdit(
    "t10-limits",
    "claim phrase inside open_findings",
    /evidence json carries claim "ready"/,
    (f) => edit(f, [], "finding", (old) => `${String(old)}; the library is ready`),
  ),
  {
    name: "unlabelled tarball mention in a gate claim",
    expect: /unlabelled tarball mention/,
    mutate: (ev) =>
      edit(
        ev,
        ["gates", 1, "evidence", 0],
        "claim",
        () => "the packed tarball installs into both copies",
      ),
  },
  ...BINDING_PROBES,
  ...ENVIRONMENT_PROBES,
];

/** Runs every probe against `validate`; baseline reasons never count as new. */
export function probeOutcomes(
  evidence: Ev,
  md: string,
  baseline: string[],
  validate: (ev: Ev, md: string) => string[],
): ProbeOutcome[] {
  const known = new Set(baseline);
  return SHAPE_PROBES.map((probe) => {
    const clone = structuredClone(evidence);
    const mdEdit = probe.mutateMd === undefined ? md : probe.mutateMd(md);
    if (!probe.mutate(clone) || mdEdit === null) {
      return { name: probe.name, status: "target missing" };
    }
    const fresh = validate(clone, mdEdit).filter((r) => !known.has(r));
    return {
      name: probe.name,
      status: fresh.some((r) => probe.expect.test(r)) ? "detected" : "undetected",
    };
  });
}

/** SHAPE reasons for every probe that did not turn SHAPE red. */
export function probeReasons(
  evidence: Ev,
  md: string,
  baseline: string[],
  validate: (ev: Ev, md: string) => string[],
): string[] {
  return probeOutcomes(evidence, md, baseline, validate)
    .filter((o) => o.status !== "detected")
    .map((o) => `shape self-test: probe ${o.name} ${o.status}`);
}
