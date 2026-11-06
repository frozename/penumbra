import { createHash } from "node:crypto";

import { RelPathSchema } from "../eval-primitives.js";
import { type CapsuleRefusal, type Provenance, refusal } from "./schema.js";

export const REF_READ_DEFAULT_MAX_BYTES = 64 * 1024;
export const REF_ERROR_EXCERPT_MAX_BYTES = 512;

/** Plan #392 P3 protected fence segments .git, .husky and hooks, stored as segment names (compared lowercased). */
export const PROTECTED_FENCE_SEGMENTS = [".git", ".husky", "hooks"] as const;

export interface FsStat {
  kind: "file" | "directory" | "other";
  size: number;
}

export interface FsPort {
  realpath(absPath: string): Promise<string>; // canonical path; rejects if missing
  stat(absPath: string): Promise<FsStat>; // rejects if missing
  read(absPath: string, opts: { maxBytes: number }): Promise<Uint8Array>; // at most maxBytes bytes
}

export interface ExcerptRedactor {
  redactString(text: string): { redacted: string };
}

export interface RefScope {
  worktree_root: string;
  authorized_handles: ReadonlySet<string>;
}

export interface RefDeps {
  fs: FsPort;
  redactor: ExcerptRedactor;
}

export interface ResolvedRef {
  ok: true;
  ref: string;
  rel_path: string;
  real_path: string;
  size: number;
  content: Uint8Array;
  truncated: boolean;
  sha256: string;
  provenance: Provenance;
}

export interface AuthorizedHandle {
  ok: true;
  handle_id: string;
}

export interface ValidFence {
  ok: true;
  fence: readonly string[];
}

function lexicalRel(ref: string): string | null {
  if (ref.length === 0) return null;
  if (ref.includes("\u0000")) return null;
  if (ref.startsWith("/") || ref.startsWith("\\")) return null;
  if (/^[A-Za-z]:[\\/]/.test(ref)) return null;
  const segments = ref.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return null;
  if (segments.length === 0) return null;
  return segments.join("/");
}

async function guarded<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, err };
  }
}

function isContained(real: string, realRoot: string): boolean {
  return real === realRoot || real.startsWith(realRoot + "/");
}

function excerpt(err: unknown, redactor: ExcerptRedactor): string {
  const message = err instanceof Error ? err.message : String(err);
  const { redacted } = redactor.redactString(message);
  return boundUtf8(redacted, REF_ERROR_EXCERPT_MAX_BYTES);
}

const TRUNCATION_MARKER = "…[truncated]";

function boundUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const markerBytes = new TextEncoder().encode(TRUNCATION_MARKER).byteLength;
  let end = Math.max(0, maxBytes - markerBytes);
  while (end > 0) {
    const next = bytes[end];
    if (next === undefined || (next & 0xc0) !== 0x80) break;
    end -= 1;
  }
  const truncated = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, end));
  return truncated + TRUNCATION_MARKER;
}

function fenceEntryViolation(entry: string): string | null {
  if (!RelPathSchema.safeParse(entry).success) return "not a literal relative path";
  const segments = entry.split("/").filter((s) => s !== "");
  const nonDot = segments.filter((s) => s !== ".");
  if (nonDot.length === 0) return "whole-tree fence";
  for (const segment of nonDot) {
    const lower = segment.toLowerCase();
    for (const protectedSegment of PROTECTED_FENCE_SEGMENTS) {
      if (lower === protectedSegment) return "protected path";
    }
  }
  return null;
}

export async function resolveRef(
  ref: string,
  scope: RefScope,
  deps: RefDeps,
  opts?: { maxBytes?: number },
): Promise<ResolvedRef | CapsuleRefusal> {
  const relPath = lexicalRel(ref);
  if (relPath === null) return refusal("ref_out_of_scope", "refusal: out of lexical scope");
  if (relPath.toLowerCase().split("/").includes(".git")) {
    return refusal("ref_out_of_scope", "refusal: .git segment in ref");
  }

  const realRootGuard = await guarded(() => deps.fs.realpath(scope.worktree_root));
  if (!realRootGuard.ok) {
    return refusal(
      "ref_unresolved",
      "worktree root unresolved: " + excerpt(realRootGuard.err, deps.redactor),
    );
  }
  const realRoot = realRootGuard.value;

  const realGuard = await guarded(() => deps.fs.realpath(realRoot + "/" + relPath));
  if (!realGuard.ok) {
    return refusal(
      "ref_unresolved",
      "refusal: unresolved: " + excerpt(realGuard.err, deps.redactor),
    );
  }
  const real = realGuard.value;

  if (!isContained(real, realRoot)) {
    return refusal("ref_out_of_scope", "refusal: path escapes worktree root");
  }
  const realRelSegments = real
    .slice(realRoot.length + 1)
    .split("/")
    .map((segment) => segment.toLowerCase());
  if (realRelSegments.includes(".git")) {
    return refusal("ref_out_of_scope", "refusal: .git segment in canonical path");
  }

  const statGuard = await guarded(() => deps.fs.stat(real));
  if (!statGuard.ok) {
    return refusal(
      "ref_unresolved",
      "refusal: stat failed: " + excerpt(statGuard.err, deps.redactor),
    );
  }
  if (statGuard.value.kind !== "file") {
    return refusal("ref_unresolved", "refusal: not a regular file");
  }
  const stat = statGuard.value;

  const maxBytes = opts?.maxBytes ?? REF_READ_DEFAULT_MAX_BYTES;
  const readGuard = await guarded(() => deps.fs.read(real, { maxBytes }));
  if (!readGuard.ok) {
    return refusal(
      "ref_unresolved",
      "refusal: read failed: " + excerpt(readGuard.err, deps.redactor),
    );
  }
  const bytes = readGuard.value;
  const truncated = stat.size > maxBytes || bytes.byteLength > maxBytes;
  const clamped = bytes.byteLength > maxBytes ? bytes.subarray(0, maxBytes) : bytes;

  return {
    ok: true,
    ref,
    rel_path: relPath,
    real_path: real,
    size: stat.size,
    content: clamped,
    truncated,
    sha256: createHash("sha256").update(clamped).digest("hex"),
    provenance: { source: "worktree", ref: relPath },
  };
}

export function authorizeHandle(
  handleId: string,
  scope: RefScope,
): AuthorizedHandle | CapsuleRefusal {
  if (handleId.length === 0 || !scope.authorized_handles.has(handleId)) {
    return refusal("unauthorized_handle", "refusal: handle not authorized");
  }
  return { ok: true, handle_id: handleId };
}

export function validateWriteFence(fence: readonly string[]): ValidFence | CapsuleRefusal {
  if (fence.length === 0) return refusal("fence_violation", "refusal: empty fence");
  for (const entry of fence) {
    const violation = fenceEntryViolation(entry);
    if (violation !== null) {
      return refusal(
        "fence_violation",
        "refusal: " +
          violation +
          " entry: " +
          excerpt(entry, { redactString: (t: string) => ({ redacted: JSON.stringify(t) }) }),
      );
    }
  }
  return { ok: true, fence };
}
