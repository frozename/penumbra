import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import type { WorkflowCtx } from "@penumbra/workflows";

function canonicalizePathForWrite(path: string): string {
  const absPath = resolve(path);
  try {
    return realpathSync(absPath);
  } catch {
    const missing: string[] = [];
    let cursor = absPath;
    for (;;) {
      missing.unshift(basename(cursor));
      const parent = dirname(cursor);
      if (parent === cursor) return absPath;
      cursor = parent;
      try {
        const realParent = realpathSync(cursor);
        return resolve(realParent, ...missing);
      } catch {}
    }
  }
}

function sanitizeFileStem(input: string): string {
  const trimmed = input.trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "persona";
}

function resolveOutDir(
  ctx: WorkflowCtx,
  outDirArg: string | undefined,
): { ok: true; path: string } | { ok: false } {
  const defaultOutDir = resolve(
    ctx.cwd,
    ".penumbra",
    "reviews",
    new Date().toISOString().replace(/:/g, "-"),
  );
  const outDir = !outDirArg
    ? defaultOutDir
    : isAbsolute(outDirArg)
      ? resolve(outDirArg)
      : resolve(ctx.cwd, outDirArg);
  const realOutDir = canonicalizePathForWrite(outDir);
  const roots = [ctx.cwd, ctx.storageRoot].map(canonicalizePathForWrite);
  // containment: compare canonical roots before any later writes to limit symlink-swap escapes.
  const allowed = roots.some(
    (root) => realOutDir === root || realOutDir.startsWith(`${root}${sep}`),
  );
  if (!allowed) return { ok: false };
  return { ok: true, path: realOutDir };
}

export { canonicalizePathForWrite, resolveOutDir, sanitizeFileStem };
