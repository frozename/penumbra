import type { HandoffRow, Services } from "@penumbra/core";

import { FsPathError, resolveInsideWorktree } from "@penumbra/core";
import { spawn } from "node:child_process";
import * as fsNode from "node:fs";
import * as path from "node:path";

import type { DaemonServices } from "../serve.js";

import { getPrincipal } from "../auth.js";
import { executeGlob, executeGrep, GrepError, type GrepOutputMode } from "../fs-search.js";
import { buildScrubbedChildEnv, redactCredentials } from "../services/shell-session-pool.js";
import { matchedDangerousPatterns, requestCommandPermission } from "./command-policy.js";
import { bodyJson, json } from "./_helpers.js";
import { resolveWorktreeForHandoff } from "./worktree-resolve.js";

const FS_READ_MAX_BYTES = 1024 * 1024; // 1 MiB

type RouteWorktree = NonNullable<ReturnType<typeof resolveWorktreeForHandoff>>;

interface RouteContext {
  handoff: HandoffRow | null;
  services: DaemonServices;
  wt: RouteWorktree;
}

interface OutputBuffer {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await bodyJson(req);
  return isRecord(raw) ? raw : {};
}

function invalidArgs(message: string): Response {
  return json({ error: { code: "invalid_args", message } }, 400);
}

function requiredNonEmptyString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" ? value : null;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === "number" ? value : null;
}

function optionalBooleanTrue(body: Record<string, unknown>, key: string): boolean {
  return body[key] === true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function internalErrorResponse(err: unknown): Response {
  return json({ error: { code: "internal_error", message: errorMessage(err) } }, 500);
}

function fsPathErrorResponse(err: FsPathError): Response {
  return json(
    { error: { code: err.code, message: err.message } },
    err.code === "outside_worktree" ? 400 : 404,
  );
}

function getRouteContext(
  req: Request,
  handoffId: string,
  _services: Services,
): RouteContext | Response {
  const services = _services as DaemonServices;
  const wt = resolveWorktreeForHandoff(services, handoffId);
  if (!wt) {
    return json(
      { error: { code: "not_found", message: `worktree for handoff ${handoffId} not found` } },
      404,
    );
  }

  const handoff = services.handoffReader.get(handoffId);
  const ownershipDenied = checkWorkerOwnership(req, handoff?.worker_id);
  if (ownershipDenied !== null) return ownershipDenied;

  return { handoff, services, wt };
}

async function resolvePathOrResponse(
  inputPath: string,
  worktreePath: string,
): Promise<string | Response> {
  try {
    return await resolveInsideWorktree(inputPath, worktreePath);
  } catch (err) {
    if (err instanceof FsPathError) {
      return fsPathErrorResponse(err);
    }
    throw err;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function realpathOrSelf(inputPath: string): string {
  try {
    return fsNode.realpathSync(inputPath);
  } catch {
    return inputPath;
  }
}

function cleanupTempFile(tmpFile: string): void {
  try {
    fsNode.unlinkSync(tmpFile);
  } catch {
    // Best-effort cleanup only.
  }
}

function tempFilePath(dir: string, prefix: string): string {
  return path.join(dir, `.${prefix}-${process.pid.toString()}-${Date.now().toString()}.tmp`);
}

function atomicWrite(targetPath: string, content: string, prefix: string): void {
  const dir = path.dirname(targetPath);
  const tmpFile = tempFilePath(dir, prefix);
  try {
    fsNode.writeFileSync(tmpFile, content, "utf8");
    fsNode.renameSync(tmpFile, targetPath);
  } catch (err) {
    cleanupTempFile(tmpFile);
    throw err;
  }
}

function resolveWriteTarget(bodyPath: string, worktreePath: string): string | Response {
  const worktreeAbs = path.resolve(worktreePath);
  const candidate = path.isAbsolute(bodyPath)
    ? path.resolve(bodyPath)
    : path.resolve(worktreeAbs, bodyPath);

  if (!isInside(worktreeAbs, candidate)) {
    return json(
      {
        error: {
          code: "outside_worktree",
          message: `path "${bodyPath}" resolves outside worktree`,
        },
      },
      400,
    );
  }

  const dir = path.dirname(candidate);
  const worktreeReal = realpathOrSelf(worktreeAbs);

  // Check the nearest existing ancestor before mkdirSync so an in-worktree
  // symlink cannot create directories outside the sandbox as a side effect.
  let existingAncestor = dir;
  while (!fsNode.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  if (!isInside(worktreeReal, realpathOrSelf(existingAncestor))) {
    return json(
      {
        error: {
          code: "outside_worktree",
          message: `parent directory of "${bodyPath}" resolves outside worktree via symlink`,
        },
      },
      400,
    );
  }

  fsNode.mkdirSync(dir, { recursive: true });

  const realDir = realpathOrSelf(dir);
  if (!isInside(worktreeReal, realDir)) {
    return json(
      {
        error: {
          code: "outside_worktree",
          message: `parent directory of "${bodyPath}" resolves outside worktree via symlink`,
        },
      },
      400,
    );
  }

  return path.join(realDir, path.basename(candidate));
}

function outputMode(value: unknown): GrepOutputMode | null {
  return value === "files_with_matches" || value === "content" ? value : null;
}

function appendOutputChunk(buffer: OutputBuffer, chunk: Buffer): void {
  if (buffer.bytes >= EXEC_OUTPUT_MAX_BYTES) return;

  const remaining = EXEC_OUTPUT_MAX_BYTES - buffer.bytes;
  if (chunk.length > remaining) {
    buffer.chunks.push(chunk.subarray(0, remaining));
    buffer.bytes += remaining;
    buffer.truncated = true;
    return;
  }

  buffer.chunks.push(chunk);
  buffer.bytes += chunk.length;
}

function outputBufferToString(buffer: OutputBuffer): string {
  return Buffer.concat(buffer.chunks).toString("utf8");
}

export function checkWorkerOwnership(
  req: Request,
  handoffWorkerId: string | null | undefined,
): Response | null {
  const principal = getPrincipal(req);
  if (principal?.kind !== "worker") {
    return null;
  }
  if (
    handoffWorkerId === null ||
    handoffWorkerId === undefined ||
    principal.worker_id !== handoffWorkerId
  ) {
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
  _services: Services,
): Promise<Response> {
  const context = getRouteContext(req, handoff_id, _services);
  if (context instanceof Response) return context;

  const body = await requestBody(req);
  const bodyPath = requiredNonEmptyString(body, "path");
  if (bodyPath === null) return invalidArgs("path (string) required");

  const resolvedPath = await resolvePathOrResponse(bodyPath, context.wt.path);
  if (resolvedPath instanceof Response) return resolvedPath;

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

    return json({
      content: buf.toString("utf8"),
      path: bodyPath,
      bytes: totalBytes,
      truncated,
    });
  } catch (err) {
    return internalErrorResponse(err);
  }
}
export async function worktreesWriteRoute(
  req: Request,
  handoff_id: string,
  _services: Services,
): Promise<Response> {
  const context = getRouteContext(req, handoff_id, _services);
  if (context instanceof Response) return context;

  const body = await requestBody(req);
  const bodyPath = requiredNonEmptyString(body, "path");
  if (bodyPath === null) return invalidArgs("path (string) required");

  const content = optionalString(body, "content");
  if (content === null) return invalidArgs("content (string) required");

  try {
    const resolvedPath = resolveWriteTarget(bodyPath, context.wt.path);
    if (resolvedPath instanceof Response) return resolvedPath;

    const existed = fsNode.existsSync(resolvedPath);
    atomicWrite(resolvedPath, content, "penumbra-write");

    const bytes_written = Buffer.byteLength(content, "utf8");
    return json({ path: bodyPath, bytes_written, created: !existed });
  } catch (err) {
    return internalErrorResponse(err);
  }
}

export async function worktreesEditRoute(
  req: Request,
  handoff_id: string,
  _services: Services,
): Promise<Response> {
  const context = getRouteContext(req, handoff_id, _services);
  if (context instanceof Response) return context;

  const body = await requestBody(req);
  const bodyPath = requiredNonEmptyString(body, "path");
  if (bodyPath === null) return invalidArgs("path (string) required");

  const oldString = optionalString(body, "old_string");
  if (oldString === null) return invalidArgs("old_string (string) required");

  const newString = optionalString(body, "new_string");
  if (newString === null) return invalidArgs("new_string (string) required");

  if (oldString === newString) {
    return json(
      { error: { code: "no_op", message: "old_string and new_string are identical" } },
      400,
    );
  }

  const replace_all = optionalBooleanTrue(body, "replace_all");
  const resolvedPath = await resolvePathOrResponse(bodyPath, context.wt.path);
  if (resolvedPath instanceof Response) return resolvedPath;

  try {
    const content = fsNode.readFileSync(resolvedPath, "utf8");

    let count = 0;
    let idx = 0;
    while ((idx = content.indexOf(oldString, idx)) !== -1) {
      count++;
      idx += oldString.length;
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
            message: `old_string appears ${count.toString()} times; pass replace_all:true to replace all`,
          },
        },
        422,
      );
    }

    const updated = replace_all
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    atomicWrite(resolvedPath, updated, "penumbra-edit");

    return json({ path: bodyPath, replacements: count });
  } catch (err) {
    return internalErrorResponse(err);
  }
}

export async function worktreesGlobRoute(
  req: Request,
  handoff_id: string,
  _services: Services,
): Promise<Response> {
  const context = getRouteContext(req, handoff_id, _services);
  if (context instanceof Response) return context;

  const body = await requestBody(req);
  const pattern = requiredNonEmptyString(body, "pattern");
  if (pattern === null) return invalidArgs("pattern (string) required");

  let searchPath: string | null = null;
  const requestedPath = optionalString(body, "path");
  if (requestedPath !== null) {
    const resolvedPath = await resolvePathOrResponse(requestedPath, context.wt.path);
    if (resolvedPath instanceof Response) return resolvedPath;
    searchPath = resolvedPath;
  }

  try {
    return json(
      await executeGlob(
        {
          pattern,
          path: searchPath,
          max_results: optionalNumber(body, "max_results"),
          include_ignored: optionalBooleanTrue(body, "include_ignored"),
        },
        context.wt.path,
      ),
    );
  } catch (err) {
    return internalErrorResponse(err);
  }
}

export async function worktreesGrepRoute(
  req: Request,
  handoff_id: string,
  _services: Services,
): Promise<Response> {
  const context = getRouteContext(req, handoff_id, _services);
  if (context instanceof Response) return context;

  const body = await requestBody(req);
  const pattern = requiredNonEmptyString(body, "pattern");
  if (pattern === null) return invalidArgs("pattern (string) required");

  let searchPath: string | null = null;
  const requestedPath = optionalString(body, "path");
  if (requestedPath !== null) {
    const resolvedPath = await resolvePathOrResponse(requestedPath, context.wt.path);
    if (resolvedPath instanceof Response) return resolvedPath;
    searchPath = resolvedPath;
  }

  try {
    return json(
      await executeGrep(
        {
          pattern,
          path: searchPath,
          glob: optionalString(body, "glob"),
          output_mode: outputMode(body.output_mode) ?? "content",
          case_insensitive: optionalBooleanTrue(body, "case_insensitive"),
          include_ignored: optionalBooleanTrue(body, "include_ignored"),
          max_results: optionalNumber(body, "max_results"),
        },
        context.wt.path,
      ),
    );
  } catch (err) {
    if (err instanceof GrepError) {
      const status = err.code === "bad_pattern" ? 400 : 500;
      return json({ error: { code: err.code, message: err.message } }, status);
    }
    return internalErrorResponse(err);
  }
}

const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
const EXEC_MAX_TIMEOUT_MS = 600_000;
const EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;

export async function worktreesExecRoute(
  req: Request,
  handoff_id: string,
  _services: Services,
): Promise<Response> {
  const context = getRouteContext(req, handoff_id, _services);
  if (context instanceof Response) return context;

  const body = await requestBody(req);
  const command = optionalString(body, "command");
  if (command === null || command.trim() === "")
    return invalidArgs("command (non-empty string) required");

  const rawTimeout = optionalNumber(body, "timeout_ms") ?? EXEC_DEFAULT_TIMEOUT_MS;
  const timeout_ms = Math.min(Math.max(1, rawTimeout), EXEC_MAX_TIMEOUT_MS);

  // Mirror shell_run's kill-switch: the session pool is constructed only when
  // shell.enabled is true, so its absence means the operator disabled shell.
  // Without this, fs_exec stays a live command-exec surface after shell is off.
  if (!context.services.shellSessionPool) {
    return json({ error: { code: "shell_disabled" } }, 503);
  }

  const shellConfig = context.services.shellConfig;
  // Validate every field the route reads (dangerousCommandsForAgent AND the two
  // fields the env-scrub/redaction path added) so a partial config fails closed
  // with 503 rather than throwing a 500 (mirrors the 0b2a466e guard intent).
  if (
    !shellConfig ||
    typeof shellConfig.dangerousCommandsForAgent !== "function" ||
    typeof shellConfig.redactOutputForAgent !== "function"
  ) {
    return json(
      {
        error: {
          code: "shell_config_unavailable",
          message: "service temporarily unavailable",
        },
      },
      503,
    );
  }
  const agentName = context.handoff?.to_agent ?? "";

  // Unify with shell_run: fs_exec must pass the same permission/trust gate the
  // shell_run route enforces before spawning, not just the dangerous-command
  // regex. Unattended dispatches whose agent auto-approves shell_run skip the
  // prompt exactly as shell_run does; everyone else raises a permission request
  // via the in-process permission service (fail-closed when none is wired).
  const generalDecision = await requestCommandPermission(context.services, {
    handoffId: handoff_id,
    agentName,
    toolName: "shell_run",
    context: { command: command.slice(0, 200) },
  });
  if (generalDecision === "reject") {
    return json(
      { error: { code: "permission_denied", message: "permission denied: shell_run" } },
      403,
    );
  }

  const matched = matchedDangerousPatterns(shellConfig, agentName, command);
  if (matched.length > 0) {
    const dangerousDecision = await requestCommandPermission(context.services, {
      handoffId: handoff_id,
      agentName,
      toolName: "shell_run.dangerous",
      context: { command: command.slice(0, 1024), matched_patterns: matched },
    });
    if (dangerousDecision === "reject") {
      return json({ error: { code: "dangerous_command", matched } }, 403);
    }
  }

  const cwd = ((): string => {
    try {
      return fsNode.realpathSync(context.wt.path);
    } catch {
      return context.wt.path;
    }
  })();

  // Scrub the child env (drop the daemon's own auth tokens + operator unset_env)
  // and redact output — parity with shell_run. This closes the PENUMBRA_TOKEN
  // worker->daemon escalation; provider API keys are dropped only if the operator
  // lists them in unset_env (output redaction is stdout-only defense-in-depth and
  // does not stop network egress like `env | curl`).
  const childEnv = buildScrubbedChildEnv(shellConfig.unsetEnv);
  const redactOut = shellConfig.redactOutputForAgent(agentName);
  const finalize = (buffer: OutputBuffer): string => {
    const text = outputBufferToString(buffer);
    return redactOut ? redactCredentials(text) : text;
  };

  return await new Promise<Response>((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });

    const stdoutBuffer: OutputBuffer = { chunks: [], bytes: 0, truncated: false };
    const stderrBuffer: OutputBuffer = { chunks: [], bytes: 0, truncated: false };

    child.stdout.on("data", (chunk: Buffer) => {
      appendOutputChunk(stdoutBuffer, chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      appendOutputChunk(stderrBuffer, chunk);
    });

    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort timeout cleanup only.
        }
      }
      resolve(
        json({
          stdout: finalize(stdoutBuffer),
          stderr: finalize(stderrBuffer),
          exit_code: null,
          timed_out: true,
          truncated: stdoutBuffer.truncated || stderrBuffer.truncated,
        }),
      );
    }, timeout_ms);

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        json({
          stdout: finalize(stdoutBuffer),
          stderr: finalize(stderrBuffer),
          exit_code: code,
          timed_out: false,
          truncated: stdoutBuffer.truncated || stderrBuffer.truncated,
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
