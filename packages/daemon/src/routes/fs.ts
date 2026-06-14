import type { Services } from "@penumbra/core";
import { resolveInsideWorktree, FsPathError } from "@penumbra/core";
import { executeGlob, executeGrep, GrepError } from "../fs-search.js";
import * as fsNode from "node:fs";

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
