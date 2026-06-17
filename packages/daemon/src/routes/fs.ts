import type { Services } from "@penumbra/core";
import { resolveInsideWorktree, FsPathError } from "@penumbra/core";
import { executeGlob, executeGrep, GrepError } from "../fs-search.js";
import * as fsNode from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { json } from "./_helpers.js";
import { resolveWorktreeForHandoff } from "./worktree-resolve.js";
import { getPrincipal } from "../auth.js";

const FS_READ_MAX_BYTES = 1024 * 1024; // 1 MiB

function checkWorkerOwnership(
  req: Request,
  handoffWorkerId: string | null | undefined,
): Response | null {
  const principal = getPrincipal(req);
  if (principal === null || principal.kind !== "worker") {
    return null;
  }
  if (handoffWorkerId == null || principal.worker_id !== handoffWorkerId) {
    return Response.json(
      {
        error: {
          code: "ownership_mismatch",
          message: "worker token does not match the handoff owner",
        },
      },
      { status: 403 },
    );
  }
  return null;
}

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
  const ownershipDenied = checkWorkerOwnership(
    req,
    services.handoffReader.get(handoff_id)?.worker_id,
  );
  if (ownershipDenied !== null) return ownershipDenied;

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
  const ownershipDenied = checkWorkerOwnership(
    req,
    services.handoffReader.get(handoff_id)?.worker_id,
  );
  if (ownershipDenied !== null) return ownershipDenied;

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

export async function worktreesEditRoute(
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
  const ownershipDenied = checkWorkerOwnership(
    req,
    services.handoffReader.get(handoff_id)?.worker_id,
  );
  if (ownershipDenied !== null) return ownershipDenied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body?.path || typeof body.path !== "string") {
    return json({ error: { code: "invalid_args", message: "path (string) required" } }, 400);
  }
  if (typeof body.old_string !== "string") {
    return json({ error: { code: "invalid_args", message: "old_string (string) required" } }, 400);
  }
  if (typeof body.new_string !== "string") {
    return json({ error: { code: "invalid_args", message: "new_string (string) required" } }, 400);
  }
  if (body.old_string === body.new_string) {
    return json(
      { error: { code: "no_op", message: "old_string and new_string are identical" } },
      400,
    );
  }

  const replace_all = body.replace_all === true;

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
    const content = fsNode.readFileSync(resolvedPath, "utf8");

    let count = 0;
    let idx = 0;
    while ((idx = content.indexOf(body.old_string, idx)) !== -1) {
      count++;
      idx += body.old_string.length;
    }

    if (count === 0) {
      return json(
        { error: { code: "string_not_found", message: `old_string not found in file` } },
        422,
      );
    }
    if (count > 1 && !replace_all) {
      return json(
        {
          error: {
            code: "string_not_unique",
            message: `old_string appears ${count} times; pass replace_all:true to replace all`,
          },
        },
        422,
      );
    }

    const updated = replace_all
      ? content.split(body.old_string).join(body.new_string)
      : content.replace(body.old_string, body.new_string);

    const dir = path.dirname(resolvedPath);
    const tmpFile = path.join(dir, `.penumbra-edit-${process.pid}-${Date.now()}.tmp`);
    try {
      fsNode.writeFileSync(tmpFile, updated, "utf8");
      fsNode.renameSync(tmpFile, resolvedPath);
    } catch (err) {
      try {
        fsNode.unlinkSync(tmpFile);
      } catch {}
      throw err;
    }

    return json({ path: body.path, replacements: count });
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
  const ownershipDenied = checkWorkerOwnership(
    req,
    services.handoffReader.get(handoff_id)?.worker_id,
  );
  if (ownershipDenied !== null) return ownershipDenied;

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
  const ownershipDenied = checkWorkerOwnership(
    req,
    services.handoffReader.get(handoff_id)?.worker_id,
  );
  if (ownershipDenied !== null) return ownershipDenied;

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

const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
const EXEC_MAX_TIMEOUT_MS = 600_000;
const EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;

export async function worktreesExecRoute(
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
  const handoff = services.handoffReader.get(handoff_id);
  const ownershipDenied = checkWorkerOwnership(req, handoff?.worker_id);
  if (ownershipDenied !== null) return ownershipDenied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body?.command || typeof body.command !== "string" || body.command.trim() === "") {
    return json(
      { error: { code: "invalid_args", message: "command (non-empty string) required" } },
      400,
    );
  }

  const rawTimeout =
    typeof body.timeout_ms === "number" ? body.timeout_ms : EXEC_DEFAULT_TIMEOUT_MS;
  const timeout_ms = Math.min(Math.max(1, rawTimeout), EXEC_MAX_TIMEOUT_MS);

  const shellConfig = (services as any).shellConfig;
  const agentName = (handoff as any)?.to_agent ?? null;
  const dangerousPatterns: string[] = shellConfig?.dangerousCommandsForAgent?.(agentName) ?? [];
  const normalizedCommand = body.command.replace(/\s+/g, " ");
  const matched = dangerousPatterns.filter((pattern: string) =>
    new RegExp(pattern).test(normalizedCommand),
  );
  if (matched.length > 0) {
    return json({ error: { code: "dangerous_command", matched } }, 403);
  }

  const cwd = (() => {
    try {
      return fsNode.realpathSync(wt.path);
    } catch {
      return wt.path;
    }
  })();

  return new Promise<Response>((resolve) => {
    const child = spawn(body.command, { shell: true, cwd });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;

    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let stderrTruncated = false;

    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdoutBytes < EXEC_OUTPUT_MAX_BYTES) {
        const remaining = EXEC_OUTPUT_MAX_BYTES - stdoutBytes;
        if (chunk.length > remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes += remaining;
          stdoutTruncated = true;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes < EXEC_OUTPUT_MAX_BYTES) {
        const remaining = EXEC_OUTPUT_MAX_BYTES - stderrBytes;
        if (chunk.length > remaining) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes += remaining;
          stderrTruncated = true;
        } else {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
      }
    });

    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(
        json({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exit_code: null,
          timed_out: true,
          truncated: stdoutTruncated || stderrTruncated,
        }),
      );
    }, timeout_ms);

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        json({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exit_code: code,
          timed_out: false,
          truncated: stdoutTruncated || stderrTruncated,
        }),
      );
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(json({ error: { code: "internal_error", message: err.message } }, 500));
    });
  });
}
