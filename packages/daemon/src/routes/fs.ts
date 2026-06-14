import type { Services } from "@penumbra/core";
import { resolveInsideWorktree, FsPathError } from "@penumbra/core";
import { executeGlob, executeGrep, GrepError } from "../fs-search.js";
import * as fsNode from "node:fs";
import * as path from "node:path";

import { json } from "./_helpers.js";
import { resolveWorktreeForHandoff } from "./worktree-resolve.js";

const FS_READ_MAX_BYTES = 1024 * 1024; // 1 MiB

export async function worktreesReadRoute(
  req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  const wt = resolveWorktreeForHandoff(services, handoff_id);
  if (!wt) {
    return json(
      { error: { code: "not_found", message: `worktree for handoff ${handoff_id} not found` } },
      404,
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body?.path || typeof body.path !== "string") {
    return json({ error: { code: "invalid_args", message: "path (string) required" } }, 400);
  }

  let resolvedPath: string;
  try {
    resolvedPath = await resolveInsideWorktree(body.path, wt.path);
  } catch (err) {
    if (err instanceof FsPathError) {
      return json(
        { error: { code: err.code, message: err.message } },
        err.code === "outside_worktree" ? 400 : 404,
      );
    }
    throw err;
  }

  try {
    const stat = fsNode.statSync(resolvedPath);
    const totalBytes = stat.size;
    const readBytes = Math.min(totalBytes, FS_READ_MAX_BYTES);
    const truncated = totalBytes > FS_READ_MAX_BYTES;

    const buf = Buffer.alloc(readBytes);
    const fd = fsNode.openSync(resolvedPath, "r");
    try {
      fsNode.readSync(fd, buf, 0, readBytes, 0);
    } finally {
      fsNode.closeSync(fd);
    }

    const relativePath = body.path;
    return json({
      content: buf.toString("utf8"),
      path: relativePath,
      bytes: totalBytes,
      truncated,
    });
  } catch (err: any) {
    return json({ error: { code: "internal_error", message: err?.message ?? String(err) } }, 500);
  }
}
export async function worktreesWriteRoute(
  req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  const wt = resolveWorktreeForHandoff(services, handoff_id);
  if (!wt) {
    return json(
      { error: { code: "not_found", message: `worktree for handoff ${handoff_id} not found` } },
      404,
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body?.path || typeof body.path !== "string") {
    return json({ error: { code: "invalid_args", message: "path (string) required" } }, 400);
  }
  if (body.content === undefined || body.content === null || typeof body.content !== "string") {
    return json({ error: { code: "invalid_args", message: "content (string) required" } }, 400);
  }

  // resolveInsideWorktree always throws not_found for non-existent targets (correct for reads,
  // wrong for writes). We need our own validation that handles files that don't yet exist.
  const worktreeAbs = path.resolve(wt.path);
  const candidate = path.isAbsolute(body.path)
    ? path.resolve(body.path)
    : path.resolve(worktreeAbs, body.path);

  // Literal path escape check (catches ../). Require candidate is strictly inside worktree.
  const rel = path.relative(worktreeAbs, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return json(
      {
        error: {
          code: "outside_worktree",
          message: `path "${body.path}" resolves outside worktree`,
        },
      },
      400,
    );
  }

  try {
    const existed = fsNode.existsSync(candidate);
    const dir = path.dirname(candidate);
    fsNode.mkdirSync(dir, { recursive: true });

    // Symlink-escape check on the now-existing parent.
    let realDir: string;
    try {
      realDir = fsNode.realpathSync(dir);
    } catch {
      realDir = dir;
    }
    const worktreeReal = (() => {
      try {
        return fsNode.realpathSync(worktreeAbs);
      } catch {
        return worktreeAbs;
      }
    })();
    const relDir = path.relative(worktreeReal, realDir);
    if (relDir.startsWith("..") || path.isAbsolute(relDir)) {
      return json(
        {
          error: {
            code: "outside_worktree",
            message: `parent directory of "${body.path}" resolves outside worktree via symlink`,
          },
        },
        400,
      );
    }

    // Atomic write: write to a temp file then rename so partial content is never visible.
    const resolvedPath = path.join(realDir, path.basename(candidate));
    const tmpFile = path.join(realDir, `.penumbra-write-${process.pid}-${Date.now()}.tmp`);
    try {
      fsNode.writeFileSync(tmpFile, body.content, "utf8");
      fsNode.renameSync(tmpFile, resolvedPath);
    } catch (err) {
      try {
        fsNode.unlinkSync(tmpFile);
      } catch {}
      throw err;
    }

    const bytes_written = Buffer.byteLength(body.content, "utf8");
    return json({ path: body.path, bytes_written, created: !existed });
  } catch (err: any) {
    return json({ error: { code: "internal_error", message: err?.message ?? String(err) } }, 500);
  }
}

export async function worktreesGlobRoute(
  req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  const wt = resolveWorktreeForHandoff(services, handoff_id);
  if (!wt) {
    return json(
      { error: { code: "not_found", message: `worktree for handoff ${handoff_id} not found` } },
      404,
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body?.pattern || typeof body.pattern !== "string") {
    return json({ error: { code: "invalid_args", message: "pattern (string) required" } }, 400);
  }

  if (body.path) {
    try {
      body.path = await resolveInsideWorktree(body.path, wt.path);
    } catch (err) {
      if (err instanceof FsPathError) {
        return json(
          { error: { code: err.code, message: err.message } },
          err.code === "outside_worktree" ? 400 : 404,
        );
      }
      throw err;
    }
  }

  try {
    return json(
      await executeGlob(
        {
          pattern: body.pattern,
          path: body.path ?? null,
          max_results: typeof body.max_results === "number" ? body.max_results : null,
          include_ignored: body.include_ignored === true,
        },
        wt.path,
      ),
    );
  } catch (err: any) {
    return json({ error: { code: "internal_error", message: err?.message ?? String(err) } }, 500);
  }
}

export async function worktreesGrepRoute(
  req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  const wt = resolveWorktreeForHandoff(services, handoff_id);
  if (!wt) {
    return json(
      { error: { code: "not_found", message: `worktree for handoff ${handoff_id} not found` } },
      404,
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body?.pattern || typeof body.pattern !== "string") {
    return json({ error: { code: "invalid_args", message: "pattern (string) required" } }, 400);
  }

  if (body.path) {
    try {
      body.path = await resolveInsideWorktree(body.path, wt.path);
    } catch (err) {
      if (err instanceof FsPathError) {
        return json(
          { error: { code: err.code, message: err.message } },
          err.code === "outside_worktree" ? 400 : 404,
        );
      }
      throw err;
    }
  }

  try {
    return json(
      await executeGrep(
        {
          pattern: body.pattern,
          path: body.path ?? null,
          glob: body.glob ?? null,
          output_mode: body.output_mode ?? "content",
          case_insensitive: body.case_insensitive === true,
          include_ignored: body.include_ignored === true,
          max_results: typeof body.max_results === "number" ? body.max_results : null,
        },
        wt.path,
      ),
    );
  } catch (err) {
    if (err instanceof GrepError) {
      const status =
        err.code === "bad_pattern" ? 400 : err.code === "engine_unavailable" ? 500 : 500;
      return json({ error: { code: err.code, message: err.message } }, status);
    }
    return json(
      {
        error: {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        },
      },
      500,
    );
  }
}
