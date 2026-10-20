import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";

export interface CodexSafetySetupContext {
  codexDir: string;
  packageDir: string;
}

export interface CodexSafetyOwnership {
  guardPath: string;
  guardHash: string;
  sentinelPath: string;
}

export interface CodexSafetySource {
  bytes: Buffer;
  guardPath: string;
  guardHash: string;
  sentinelPath: string;
}

export interface PreparedCodexSafetySetup {
  current: Buffer | null;
  next: Buffer | null;
  ownership?: CodexSafetyOwnership;
}

type CodexSafetySetupState = {
  state: "installed" | "absent" | "unavailable" | "conflict";
  detail: string;
};

const GUARD_NAME = "penumbra-agent-gc-guard.sh";

function hash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function paths(opts: CodexSafetySetupContext): { guardPath: string; sentinelPath: string } {
  const installationDir = join(opts.codexDir, "penumbra");
  return {
    guardPath: join(installationDir, "hooks", GUARD_NAME),
    sentinelPath: join(installationDir, "allow-agent-gc"),
  };
}

function assertPathComponent(
  current: string,
  path: string,
  requireExisting: boolean,
  isLeaf: boolean,
): boolean {
  const stat = lstatSync(current, { throwIfNoEntry: false });
  if (!stat) {
    if (requireExisting) throw new Error(`required path is absent: ${path}`);
    return false;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`symlinked managed safety path is not allowed: ${current}`);
  }
  if (!isLeaf && !stat.isDirectory()) {
    throw new Error(`non-directory managed safety path is not allowed: ${current}`);
  }
  return true;
}

function assertNoSymlinkPath(path: string, requireExisting = false): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    if (!assertPathComponent(current, path, requireExisting, index === parts.length - 1)) return;
  }
  if (requireExisting && realpathSync(absolute) !== absolute) {
    throw new Error(`managed safety path is not canonical: ${path}`);
  }
}

function readManagedGuard(path: string): Buffer | null {
  assertNoSymlinkPath(path);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`managed safety guard is not a regular file: ${path}`);
  return readFileSync(path);
}

function equal(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function atomicWrite(path: string, content: Buffer): void {
  assertNoSymlinkPath(path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${parse(path).base}.penumbra-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function readCodexSafetySource(
  opts: CodexSafetySetupContext,
): CodexSafetySource | undefined {
  const sourcePath = join(opts.packageDir, "hooks", GUARD_NAME);
  const stat = lstatSync(sourcePath, { throwIfNoEntry: false });
  if (!stat) return undefined;
  assertNoSymlinkPath(sourcePath, true);
  if (!stat.isFile()) throw new Error(`packaged safety guard is not a regular file: ${sourcePath}`);
  const bytes = readFileSync(sourcePath);
  return { bytes, guardHash: hash(bytes), ...paths(opts) };
}

export function isValidCodexSafetyOwnership(
  value: unknown,
  opts: CodexSafetySetupContext,
): value is CodexSafetyOwnership {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expected = paths(opts);
  return (
    candidate.guardPath === expected.guardPath &&
    candidate.sentinelPath === expected.sentinelPath &&
    typeof candidate.guardHash === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.guardHash)
  );
}

export function prepareCodexSafetySetup(
  opts: CodexSafetySetupContext,
  source: CodexSafetySource | undefined,
  previous: CodexSafetyOwnership | undefined,
  enabled: boolean,
): PreparedCodexSafetySetup {
  if (previous && !isValidCodexSafetyOwnership(previous, opts)) {
    throw new Error("ownership record contains invalid managed safety paths");
  }
  if (previous && !source && enabled) {
    throw new Error("packaged safety guard is absent");
  }
  const expected = paths(opts);
  const current = readManagedGuard(expected.guardPath);
  if (!previous && current)
    throw new Error(`unowned managed safety guard exists: ${expected.guardPath}`);
  if (previous && current && hash(current) !== previous.guardHash) {
    throw new Error(`managed safety guard was modified: ${expected.guardPath}`);
  }
  if (!enabled) return { current, next: null };
  if (!source) throw new Error("packaged safety guard is absent");
  return {
    current,
    next: source.bytes,
    ownership: {
      guardPath: source.guardPath,
      guardHash: source.guardHash,
      sentinelPath: source.sentinelPath,
    },
  };
}

function inspectUnownedGuard(current: Buffer | null, enabled: boolean): CodexSafetySetupState {
  if (current) return { state: "conflict", detail: "unowned managed Codex safety guard exists" };
  return enabled
    ? { state: "absent", detail: "managed Codex safety guard is absent" }
    : { state: "unavailable", detail: "no qualified Codex command safety hook is available" };
}

export function inspectCodexSafetySetup(
  opts: CodexSafetySetupContext,
  source: CodexSafetySource | undefined,
  previous: CodexSafetyOwnership | undefined,
  enabled: boolean,
): CodexSafetySetupState {
  try {
    if (previous && !isValidCodexSafetyOwnership(previous, opts)) {
      throw new Error("ownership record contains invalid managed safety paths");
    }
    const current = readManagedGuard(previous?.guardPath ?? paths(opts).guardPath);
    if (!previous) return inspectUnownedGuard(current, enabled);
    if (!current) return { state: "absent", detail: "managed Codex safety guard is missing" };
    if (hash(current) !== previous.guardHash) {
      return { state: "conflict", detail: "managed Codex safety guard was modified" };
    }
    if (enabled && source && source.guardHash !== previous.guardHash) {
      return { state: "absent", detail: "managed Codex safety guard update is pending" };
    }
    return { state: "installed", detail: "managed Codex safety guard matches its recorded hash" };
  } catch (error) {
    return { state: "conflict", detail: error instanceof Error ? error.message : String(error) };
  }
}

export function applyCodexSafetySetup(
  _opts: CodexSafetySetupContext,
  prepared: PreparedCodexSafetySetup,
): boolean {
  const guardPath = prepared.ownership?.guardPath ?? paths(_opts).guardPath;
  if (equal(prepared.current, prepared.next)) return false;
  if (!equal(readManagedGuard(guardPath), prepared.current)) {
    throw new Error(
      "managed safety guard changed before installation; current bytes were preserved",
    );
  }
  if (prepared.next) atomicWrite(guardPath, prepared.next);
  else if (prepared.current) unlinkSync(guardPath);
  return true;
}

export function restoreCodexSafetySetup(
  opts: CodexSafetySetupContext,
  prepared: PreparedCodexSafetySetup,
): void {
  const guardPath = prepared.ownership?.guardPath ?? paths(opts).guardPath;
  if (equal(prepared.current, prepared.next)) return;
  if (!equal(readManagedGuard(guardPath), prepared.next)) {
    throw new Error("managed safety guard changed during rollback; current bytes were preserved");
  }
  if (prepared.current) atomicWrite(guardPath, prepared.current);
  else if (prepared.next) unlinkSync(guardPath);
}
