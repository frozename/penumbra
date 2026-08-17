import { createHash } from "node:crypto";

export interface BunTestReport {
  rawOutput: string;
  output: string;
  fails: number | null;
  errors: number;
  reachedSummary: boolean;
  knownPanic: boolean;
  failureKeys: string[];
  failureNames: string[];
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

function lastNum(out: string, re: RegExp): number | null {
  const matches = [...out.matchAll(re)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
}

function normalizeFailureName(name: string): string {
  return name.replace(/\s+\[[^\]\n]*\]\s*$/, "").trim();
}

function collectNames(out: string, marker: "fail" | "error"): string[] {
  const names: string[] = [];
  const re = new RegExp(`^\\(${marker}\\)\\s+(.+?)\\s*$`, "gm");
  for (const match of out.matchAll(re)) {
    const raw = match[1];
    if (!raw) continue;
    const normalized = normalizeFailureName(raw);
    if (normalized) names.push(normalized);
  }
  return names;
}

function fingerprintProjection(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function normalizeSuitePath(path: string): string {
  let normalized = path.trim();
  const packageIndex = normalized.lastIndexOf("/packages/");
  if (packageIndex >= 0) normalized = normalized.slice(packageIndex + 1);
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function suitePathFromHeader(line: string): string | null {
  const match = line.match(/^(.+?\.(?:test|spec)\.[cm]?[tj]sx?):\s*$/);
  return match?.[1] ? normalizeSuitePath(match[1]) : null;
}

function suitePathFromStack(line: string): string | null {
  const match = line.match(/\bat\s+(?:file:\/\/)?(.+?\.(?:test|spec)\.[cm]?[tj]sx?):\d+:\d+/);
  return match?.[1] ? normalizeSuitePath(match[1]) : null;
}

function collectFailureSuitePaths(out: string): string[] {
  const suitePaths = new Set<string>();
  let currentSuite: string | null = null;
  let pendingUnhandledError = false;

  for (const line of out.split(/\r?\n/)) {
    const suitePath = suitePathFromHeader(line);
    if (suitePath) {
      currentSuite = suitePath;
      pendingUnhandledError = false;
      continue;
    }

    if (/^\((?:fail|error)\)\s+/.test(line) && currentSuite) {
      suitePaths.add(currentSuite);
    }

    if (line === "# Unhandled error between tests") {
      if (currentSuite) suitePaths.add(currentSuite);
      pendingUnhandledError = currentSuite === null;
      continue;
    }

    if (pendingUnhandledError) {
      const stackSuitePath = suitePathFromStack(line);
      if (stackSuitePath) {
        suitePaths.add(stackSuitePath);
        pendingUnhandledError = false;
      }
    }
  }

  return [...suitePaths].sort();
}

function collectUnhandledErrorNames(out: string): string[] {
  const errorNames = new Set<string>();
  let currentSuite: string | null = null;
  let pendingUnhandledError = false;

  for (const line of out.split(/\r?\n/)) {
    const suitePath = suitePathFromHeader(line);
    if (suitePath) {
      currentSuite = suitePath;
      pendingUnhandledError = false;
      continue;
    }

    if (line === "# Unhandled error between tests") {
      if (currentSuite) errorNames.add(currentSuite);
      pendingUnhandledError = currentSuite === null;
      continue;
    }

    if (pendingUnhandledError) {
      const stackSuitePath = suitePathFromStack(line);
      if (stackSuitePath) {
        errorNames.add(stackSuitePath);
        pendingUnhandledError = false;
      }
    }
  }

  return [...errorNames].sort();
}

function unenumerableFailureKey(init: {
  fails: number | null;
  errors: number;
  reportedFailureCount: number;
  failureKeys: string[];
  failureSuitePaths: string[];
}): string {
  const sortedKeys = [...init.failureKeys].sort();
  const sortedSuitePaths = [...new Set(init.failureSuitePaths)].sort();
  const missingCount = Math.max(0, init.reportedFailureCount - init.failureKeys.length);
  const projection = [
    `fails=${init.fails ?? "unknown"}`,
    `errors=${init.errors}`,
    `known=${init.failureKeys.length}`,
    `missing=${missingCount}`,
    `keys=${fingerprintProjection(sortedKeys)}`,
    `suites=${fingerprintProjection(sortedSuitePaths)}`,
  ];
  return `unparsed:${projection.join(":")}`;
}

export function parseBunTestReport(rawOutput: string): BunTestReport {
  const output = rawOutput.replaceAll(ANSI_PATTERN, "");
  const fails = lastNum(output, /(\d+)\s+fail\b/g);
  const errors = lastNum(output, /(\d+)\s+error\b/g) ?? 0;
  const reachedSummary = /Ran\s+\d+\s+tests?\b/.test(output);
  const knownPanic = /Bun has crashed|panic\(main thread\)/.test(output);
  const failNames = collectNames(output, "fail");
  const errorNames = [...collectNames(output, "error"), ...collectUnhandledErrorNames(output)];
  const failureNames = [...failNames, ...errorNames];
  const failureKeys = [
    ...failNames.map((name) => `fail:${name}`),
    ...errorNames.map((name) => `error:${name}`),
  ];
  const failureSuitePaths = collectFailureSuitePaths(output);
  const reportedFailureCount = (fails ?? 0) + errors;
  if (reportedFailureCount > failureKeys.length) {
    failureKeys.push(
      unenumerableFailureKey({
        fails,
        errors,
        reportedFailureCount,
        failureKeys,
        failureSuitePaths,
      }),
    );
  }
  return {
    rawOutput,
    output,
    fails,
    errors,
    reachedSummary,
    knownPanic,
    failureKeys,
    failureNames,
  };
}

export function isKnownBunTeardownPanicPass(report: BunTestReport): boolean {
  return report.reachedSummary && report.fails === 0 && report.errors === 0 && report.knownPanic;
}
