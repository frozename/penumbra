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
];

/** Runs every probe against `validate`; baseline reasons never count as new. */
export function probeOutcomes(
  evidence: Ev,
  baseline: string[],
  validate: (ev: Ev) => string[],
): ProbeOutcome[] {
  const known = new Set(baseline);
  return SHAPE_PROBES.map((probe) => {
    const clone = structuredClone(evidence);
    if (!probe.mutate(clone)) return { name: probe.name, status: "target missing" };
    const fresh = validate(clone).filter((r) => !known.has(r));
    return {
      name: probe.name,
      status: fresh.some((r) => probe.expect.test(r)) ? "detected" : "undetected",
    };
  });
}

/** SHAPE reasons for every probe that did not turn SHAPE red. */
export function probeReasons(
  evidence: Ev,
  baseline: string[],
  validate: (ev: Ev) => string[],
): string[] {
  return probeOutcomes(evidence, baseline, validate)
    .filter((o) => o.status !== "detected")
    .map((o) => `shape self-test: probe ${o.name} ${o.status}`);
}
