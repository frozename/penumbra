import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  authorizeHandle,
  type ExcerptRedactor,
  type FsPort,
  type FsStat,
  REF_ERROR_EXCERPT_MAX_BYTES,
  REF_READ_DEFAULT_MAX_BYTES,
  type RefDeps,
  type RefScope,
  resolveRef,
  validateWriteFence,
} from "@src/dispatch/capsule/index.js";
import { RelPathSchema } from "@src/dispatch/eval-primitives.js";
import { ValuePatternRedactor } from "@src/redaction/value-patterns.js";

const SCOPE: RefScope = { worktree_root: "/repo", authorized_handles: new Set<string>() };

const _r: ExcerptRedactor = new ValuePatternRedactor([]);
void _r;

const utf8 = new TextEncoder();

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type FakeFsSpec = {
  caseInsensitive?: boolean;
  files: Record<string, string>;
  symlinks?: Record<string, string>;
};

type FakeFsCalls = {
  read: { maxBytes: number; path: string }[];
  realpath: string[];
  stat: string[];
};

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function parentDirs(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    let current = path.slice(0, path.lastIndexOf("/"));
    while (current.length > 1 && current.startsWith("/") && !dirs.has(current)) {
      dirs.add(current);
      current = current.slice(0, current.lastIndexOf("/"));
    }
  }
  return dirs;
}

function makeFakeFs(spec: FakeFsSpec): { calls: FakeFsCalls; fs: FsPort } {
  const files = new Map(Object.entries(spec.files));
  const symlinks = new Map(Object.entries(spec.symlinks ?? {}));
  const insensitive = spec.caseInsensitive === true;
  const dirs = parentDirs([...files.keys(), ...symlinks.keys(), ...symlinks.values()]);
  const known = new Set<string>([...files.keys(), ...symlinks.keys(), ...dirs]);
  const calls: FakeFsCalls = { read: [], realpath: [], stat: [] };

  const storedPath = (path: string): string | undefined => {
    if (known.has(path)) {
      return path;
    }
    if (!insensitive) {
      return undefined;
    }
    const lowered = path.toLowerCase();
    for (const candidate of known) {
      if (candidate.toLowerCase() === lowered) {
        return candidate;
      }
    }
    return undefined;
  };

  const linkTarget = (path: string): string | undefined => {
    const direct = symlinks.get(path);
    if (direct !== undefined) {
      return direct;
    }
    if (!insensitive) {
      return undefined;
    }
    const lowered = path.toLowerCase();
    for (const [key, target] of symlinks) {
      if (key.toLowerCase() === lowered) {
        return target;
      }
    }
    return undefined;
  };

  const expandLink = (
    resolved: readonly string[],
    target: string,
    rest: readonly string[],
  ): { prefix: string[]; rest: string[] } => {
    if (target.startsWith("/")) {
      return { prefix: [], rest: [...pathSegments(target), ...rest] };
    }
    const prefix = [...resolved];
    for (const segment of pathSegments(target)) {
      if (segment === "..") {
        prefix.pop();
      } else if (segment !== ".") {
        prefix.push(segment);
      }
    }
    return { prefix, rest: [...rest] };
  };

  const resolveStep = (
    resolved: readonly string[],
    segments: readonly string[],
  ): { prefix: string[]; rest: string[] } | undefined => {
    const head = segments[0]!;
    const rest = [...segments.slice(1)];
    if (head === ".") {
      return { prefix: [...resolved], rest };
    }
    if (head === "..") {
      return { prefix: resolved.slice(0, -1), rest };
    }
    const stored = storedPath(`/${[...resolved, head].join("/")}`);
    if (stored === undefined) {
      return undefined;
    }
    const target = linkTarget(stored);
    if (target === undefined) {
      return { prefix: [...resolved, stored.slice(stored.lastIndexOf("/") + 1)], rest };
    }
    return expandLink(resolved, target, rest);
  };

  const canonicalPath = (absPath: string): string | undefined => {
    if (!absPath.startsWith("/")) {
      return undefined;
    }
    let segments = pathSegments(absPath);
    let resolved: string[] = [];
    let depth = 0;
    while (segments.length > 0 && depth < 64) {
      depth += 1;
      const step = resolveStep(resolved, segments);
      if (step === undefined) {
        return undefined;
      }
      resolved = step.prefix;
      segments = step.rest;
    }
    const joined = `/${resolved.join("/")}`;
    return segments.length === 0 && known.has(joined) ? joined : undefined;
  };

  const fs: FsPort = {
    read: (absPath, opts) => {
      calls.read.push({ maxBytes: opts.maxBytes, path: absPath });
      const resolved = canonicalPath(absPath);
      const content = resolved === undefined ? undefined : files.get(resolved);
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${absPath}`));
      }
      return Promise.resolve(utf8.encode(content).slice(0, opts.maxBytes));
    },
    realpath: (absPath) => {
      calls.realpath.push(absPath);
      const resolved = canonicalPath(absPath);
      if (resolved === undefined) {
        return Promise.reject(new Error(`ENOENT: ${absPath}`));
      }
      return Promise.resolve(resolved);
    },
    stat: (absPath) => {
      calls.stat.push(absPath);
      const resolved = canonicalPath(absPath);
      if (resolved === undefined) {
        return Promise.reject(new Error(`ENOENT: ${absPath}`));
      }
      const content = files.get(resolved);
      if (content !== undefined) {
        return Promise.resolve<FsStat>({ kind: "file", size: utf8.encode(content).byteLength });
      }
      if (dirs.has(resolved)) {
        return Promise.resolve<FsStat>({ kind: "directory", size: 0 });
      }
      return Promise.resolve<FsStat>({ kind: "other", size: 0 });
    },
  };
  return { calls, fs };
}

function makeDeps(fs: FsPort): RefDeps {
  return {
    fs,
    redactor: new ValuePatternRedactor([
      { id: "test_secret", pattern: /sk-[a-z0-9]+/g, replacement: "[REDACTED]" },
    ]),
  };
}

function expectNoFsCalls(calls: FakeFsCalls): void {
  expect(calls.read).toEqual([]);
  expect(calls.realpath).toEqual([]);
  expect(calls.stat).toEqual([]);
}

function expectNoReads(calls: FakeFsCalls): void {
  expect(calls.read).toEqual([]);
}

describe("resolveRef", () => {
  test("resolves an in-scope ref with content, hash and provenance", async () => {
    const { fs } = makeFakeFs({ files: { "/repo/src/a.ts": "hello" } });
    const result = await resolveRef("src/a.ts", SCOPE, makeDeps(fs));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rel_path).toBe("src/a.ts");
      expect(result.real_path).toBe("/repo/src/a.ts");
      expect(result.size).toBe(5);
      expect(result.truncated).toBe(false);
      expect(result.sha256).toBe(sha256("hello"));
      expect(result.provenance).toEqual({ source: "worktree", ref: "src/a.ts" });
      expect(new TextDecoder().decode(result.content)).toBe("hello");
    }
  });

  test("normalizes dot segments and duplicate separators", async () => {
    const { fs } = makeFakeFs({ files: { "/repo/src/a.ts": "hello" } });
    const result = await resolveRef("./src//a.ts", SCOPE, makeDeps(fs));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rel_path).toBe("src/a.ts");
      expect(result.real_path).toBe("/repo/src/a.ts");
    }
  });

  test.each(["../etc/passwd", "src/../../x", "src\\..\\..\\x"])(
    "refuses traversal ref %j without touching the fs",
    async (ref) => {
      const { calls, fs } = makeFakeFs({ files: {} });
      const result = await resolveRef(ref, SCOPE, makeDeps(fs));
      expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
      expectNoFsCalls(calls);
    },
  );

  test.each(["/etc/passwd", "C:\\x", "\\\\server\\x"])(
    "refuses absolute ref %j without touching the fs",
    async (ref) => {
      const { calls, fs } = makeFakeFs({ files: {} });
      const result = await resolveRef(ref, SCOPE, makeDeps(fs));
      expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
      expectNoFsCalls(calls);
    },
  );

  test("refuses a ref containing a NUL byte without touching the fs", async () => {
    const { calls, fs } = makeFakeFs({ files: {} });
    const result = await resolveRef("src/a\u0000.ts", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
    expectNoFsCalls(calls);
  });

  test("refuses a ref that escapes the worktree through a symlink", async () => {
    const { fs } = makeFakeFs({
      files: { "/outside/secret": "s" },
      symlinks: { "/repo/link": "/outside" },
    });
    const result = await resolveRef("link/secret", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
  });

  test("refuses a case-variant alias that escapes on a case-insensitive fs", async () => {
    const { fs } = makeFakeFs({
      caseInsensitive: true,
      files: { "/outside/x.txt": "x" },
      symlinks: { "/repo/escape": "/outside" },
    });
    const result = await resolveRef("Escape/x.txt", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
  });

  test("realpaths a non-canonical worktree root before resolving", async () => {
    const { fs } = makeFakeFs({ caseInsensitive: true, files: { "/repo/a.txt": "a" } });
    const scope: RefScope = { worktree_root: "/Repo", authorized_handles: new Set<string>() };
    const result = await resolveRef("a.txt", scope, makeDeps(fs));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rel_path).toBe("a.txt");
      expect(result.real_path).toBe("/repo/a.txt");
    }
  });

  test("refuses a symlink whose target only shares a string prefix with the root", async () => {
    const { fs } = makeFakeFs({
      files: { "/repo-evil/x": "x" },
      symlinks: { "/repo/sib": "/repo-evil" },
    });
    const result = await resolveRef("sib/x", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
  });

  test("refuses the empty ref", async () => {
    const { fs } = makeFakeFs({ files: {} });
    const result = await resolveRef("", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
  });

  test("returns ref_unresolved for a missing file", async () => {
    const { fs } = makeFakeFs({ files: { "/repo/src/a.ts": "x" } });
    const result = await resolveRef("src/nope.ts", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_unresolved", ok: false });
  });

  test("returns ref_unresolved for a directory ref", async () => {
    const { fs } = makeFakeFs({ files: { "/repo/src/a.ts": "x" } });
    const result = await resolveRef("src", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_unresolved", ok: false });
  });

  test("refuses stat kind 'other' (e.g. a FIFO) even when the port reads it successfully", async () => {
    const inner = makeFakeFs({ files: { "/repo/fifo": "p" } });
    const fs: FsPort = {
      ...inner.fs,
      stat: () => Promise.resolve<FsStat>({ kind: "other", size: 1 }),
    };
    const result = await resolveRef("fifo", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_unresolved", ok: false });
  });

  test("refuses stat kind 'directory' even when the port reads it successfully", async () => {
    const inner = makeFakeFs({ files: { "/repo/src/a.ts": "x" } });
    const fs: FsPort = {
      ...inner.fs,
      stat: () => Promise.resolve<FsStat>({ kind: "directory", size: 1 }),
    };
    const result = await resolveRef("src/a.ts", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_unresolved", ok: false });
  });

  test.each([".git/config", "sub/.git/HEAD", ".GIT/config"])(
    "refuses a ref with a .git segment %j without touching the fs",
    async (ref) => {
      const { calls, fs } = makeFakeFs({
        files: {
          "/repo/.git/config": "x",
          "/repo/sub/.git/HEAD": "y",
          "/repo/.GIT/config": "z",
        },
      });
      const result = await resolveRef(ref, SCOPE, makeDeps(fs));
      expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
      expectNoFsCalls(calls);
    },
  );

  test("refuses a directory symlink into .git even though the canonical path stays in the worktree", async () => {
    const { calls, fs } = makeFakeFs({
      files: { "/repo/.git/config": "token sk-secret" },
      symlinks: { "/repo/g": "/repo/.git" },
    });
    const result = await resolveRef("g/config", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
    expectNoReads(calls);
  });

  test("refuses a file symlink directly to .git/config", async () => {
    const { calls, fs } = makeFakeFs({
      files: { "/repo/.git/config": "token sk-secret" },
      symlinks: { "/repo/cfg": "/repo/.git/config" },
    });
    const result = await resolveRef("cfg", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
    expectNoReads(calls);
  });

  test("refuses a case-variant symlink into .GIT on a case-insensitive fs", async () => {
    const { calls, fs } = makeFakeFs({
      caseInsensitive: true,
      files: { "/repo/.GIT/config": "token sk-secret" },
      symlinks: { "/repo/G": "/repo/.GIT" },
    });
    const result = await resolveRef("G/config", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_out_of_scope", ok: false });
    expectNoReads(calls);
  });
});

describe("authorizeHandle", () => {
  const scope: RefScope = {
    authorized_handles: new Set(["h1"]),
    worktree_root: "/repo",
  };

  test.each(["h2", ""])("rejects handle %j", (handleId) => {
    expect(authorizeHandle(handleId, scope)).toMatchObject({
      code: "unauthorized_handle",
      ok: false,
    });
  });

  test("accepts an authorized handle", () => {
    expect(authorizeHandle("h1", scope)).toEqual({ handle_id: "h1", ok: true });
  });
});

const FENCE_ENTRY_VIOLATIONS = [
  "../x",
  "src/../../x",
  "/abs",
  "C:\\x",
  "a\u0000b",
  "**/pre-commit",
  ".g?t/config",
  "[.]git/config",
  "{.git,src}/x",
  ".hus*/pre-commit",
  "**/*.sh",
  "**",
  "*",
  "**/*",
  ".",
  "./",
  "./.",
  ".git/hooks/pre-commit",
  ".git",
  ".GIT/config",
  ".husky/pre-commit",
  ".Husky/x",
  "scripts/hooks/x.sh",
  "a/HOOKS/b",
] as const;

const FENCE_LIST_VIOLATIONS: { fence: readonly string[]; name: string }[] = [
  { fence: [], name: "empty fence" },
  { fence: [""], name: "empty entry" },
  { fence: ["src", "tools/hooks"], name: "one bad entry poisons the fence" },
];

describe("validateWriteFence", () => {
  test.each([...FENCE_ENTRY_VIOLATIONS])("rejects fence entry %j", (entry) => {
    expect(validateWriteFence([entry])).toMatchObject({ code: "fence_violation", ok: false });
  });

  test.each(FENCE_LIST_VIOLATIONS)("rejects fence: $name", ({ fence }) => {
    expect(validateWriteFence(fence)).toMatchObject({ code: "fence_violation", ok: false });
  });

  test("fail-closed: any 'hooks' segment is refused, including packages/console/src/hooks (plan #392 P3 **/hooks/**)", () => {
    expect(validateWriteFence(["packages/console/src/hooks/useX.ts"])).toMatchObject({
      code: "fence_violation",
      ok: false,
    });
  });

  test("accepts literal in-scope fence entries and echoes them back", () => {
    const fence = [
      "packages/core/src/dispatch/capsule",
      "docs/x.md",
      "packages/core/src/dispatch/capsule/refs.ts",
    ];
    expect(validateWriteFence(fence)).toEqual({ fence, ok: true });
    for (const entry of fence) {
      expect(RelPathSchema.safeParse(entry).success).toBe(true);
    }
  });
});

describe("resolveRef byte cap", () => {
  test("truncates oversized content to maxBytes", async () => {
    const { fs } = makeFakeFs({ files: { "/repo/big.txt": "x".repeat(100) } });
    const result = await resolveRef("big.txt", SCOPE, makeDeps(fs), { maxBytes: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.byteLength).toBe(10);
      expect(result.truncated).toBe(true);
      expect(result.size).toBe(100);
      expect(result.sha256).toBe(sha256("x".repeat(10)));
    }
  });

  test("does not mark an exact-fit read as truncated", async () => {
    const { fs } = makeFakeFs({ files: { "/repo/exact.txt": "y".repeat(10) } });
    const result = await resolveRef("exact.txt", SCOPE, makeDeps(fs), { maxBytes: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.byteLength).toBe(10);
      expect(result.truncated).toBe(false);
    }
  });

  test("cuts a misbehaving port's over-long read to maxBytes", async () => {
    const inner = makeFakeFs({ files: { "/repo/mis.txt": "z".repeat(50) } });
    const fs: FsPort = {
      ...inner.fs,
      read: () => Promise.resolve(utf8.encode("z".repeat(50))),
    };
    const result = await resolveRef("mis.txt", SCOPE, makeDeps(fs), { maxBytes: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.byteLength).toBe(10);
      expect(result.truncated).toBe(true);
    }
  });

  test("marks truncated when the port over-reads despite a small stat size", async () => {
    const inner = makeFakeFs({ files: { "/repo/lie.txt": "small" } });
    const fs: FsPort = {
      ...inner.fs,
      read: () => Promise.resolve(utf8.encode("z".repeat(50))),
    };
    const result = await resolveRef("lie.txt", SCOPE, makeDeps(fs), { maxBytes: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.size).toBe(5);
      expect(result.content.byteLength).toBe(10);
      expect(result.truncated).toBe(true);
    }
  });

  test("defaults the read cap to REF_READ_DEFAULT_MAX_BYTES", async () => {
    const { calls, fs } = makeFakeFs({ files: { "/repo/small.txt": "s" } });
    const result = await resolveRef("small.txt", SCOPE, makeDeps(fs));
    expect(result.ok).toBe(true);
    expect(REF_READ_DEFAULT_MAX_BYTES).toBe(65536);
    expect(calls.read.length).toBeGreaterThan(0);
    for (const call of calls.read) {
      expect(call.maxBytes).toBe(65536);
    }
  });
});

describe("resolveRef port failures", () => {
  test("redacts and bounds error excerpts in refusals", async () => {
    const boom = new Error(`EACCES token sk-abc123 ${"x".repeat(10000)}`);
    const fs: FsPort = {
      read: () => Promise.reject(boom),
      realpath: (absPath) =>
        absPath === "/repo/boom" ? Promise.reject(boom) : Promise.resolve(absPath),
      stat: () => Promise.reject(boom),
    };
    const result = await resolveRef("boom", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_unresolved", ok: false });
    if (!result.ok) {
      expect(result.detail).not.toContain("sk-abc123");
      expect(result.detail).toContain("[REDACTED]");
      expect(new TextEncoder().encode(result.detail).byteLength).toBeLessThanOrEqual(1024);
    }
  });

  test("bounds a 10,000-byte multibyte error excerpt to the exact cap without replacement chars", async () => {
    const boom = new Error("é".repeat(5000));
    const fs: FsPort = {
      read: () => Promise.reject(boom),
      realpath: (absPath) =>
        absPath === "/repo/boom" ? Promise.reject(boom) : Promise.resolve(absPath),
      stat: () => Promise.reject(boom),
    };
    const result = await resolveRef("boom", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_unresolved", ok: false });
    if (!result.ok) {
      const prefix = "refusal: unresolved: ";
      expect(result.detail.startsWith(prefix)).toBe(true);
      const excerpt = result.detail.slice(prefix.length);
      expect(utf8.encode(excerpt).byteLength).toBe(REF_ERROR_EXCERPT_MAX_BYTES);
      expect(excerpt).not.toContain("\uFFFD");
      expect(excerpt.endsWith("…[truncated]")).toBe(true);
    }
  });

  test("cuts a multibyte excerpt on a code-point boundary when the budget splits a character", async () => {
    const boom = new Error("😀".repeat(2500));
    const fs: FsPort = {
      read: () => Promise.reject(boom),
      realpath: (absPath) =>
        absPath === "/repo/boom" ? Promise.reject(boom) : Promise.resolve(absPath),
      stat: () => Promise.reject(boom),
    };
    const result = await resolveRef("boom", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_unresolved", ok: false });
    if (!result.ok) {
      const prefix = "refusal: unresolved: ";
      expect(result.detail.startsWith(prefix)).toBe(true);
      const excerpt = result.detail.slice(prefix.length);
      expect(utf8.encode(excerpt).byteLength).toBeLessThanOrEqual(REF_ERROR_EXCERPT_MAX_BYTES);
      expect(excerpt).not.toContain("\uFFFD");
      expect(excerpt.endsWith("…[truncated]")).toBe(true);
    }
  });

  test("turns a synchronously throwing port into a typed refusal", async () => {
    const fs: FsPort = {
      read: () => Promise.reject(new Error("unused")),
      realpath: () => {
        throw new Error("sync boom");
      },
      stat: () => Promise.reject(new Error("unused")),
    };
    const result = await resolveRef("boom", SCOPE, makeDeps(fs));
    expect(result).toMatchObject({ code: "ref_unresolved", ok: false });
  });
});
