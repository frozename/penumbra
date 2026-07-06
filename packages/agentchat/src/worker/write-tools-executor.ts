import type { Logger } from "@penumbra/core";

import { FsPathError, resolveInsideWorktree } from "@penumbra/core";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path, { dirname, isAbsolute, relative, resolve } from "node:path";

import type { ToolCallContext } from "../sdk/adapter.js";
import type { PermissionCallback } from "./permission-callback.js";
import type { SandboxConfig } from "./sandbox-config.js";

import {
  computeSandboxEnvKeys,
  spawnSandboxed,
  type SpawnSandboxedResult,
} from "./sandbox-spawn.js";
import {
  EditAmbiguousError,
  EditMissError,
  IoError,
  NotAFileError,
  OperationRejectedError,
  OutsideWorktreeError,
  TerminalCapExceededError,
  TerminalNotFoundError,
} from "./write-tools-errors.js";

export interface AuditEmitter {
  emit(eventType: string, payload: unknown): Promise<void>;
}

export interface WriteToolsExecutorOpts {
  worktreeRoot: string;
  permissionCallback: PermissionCallback;
  auditEmitter: AuditEmitter;
  sandboxConfig: SandboxConfig;
  logger: Pick<Logger, "warn" | "info" | "debug" | "error">;
  /** Dispatch + handoff identity for audit emission and one-shot terminal scoping */
  handoffId: string;
  dispatchId: string;
}

export interface ExitStatus {
  exitCode: number;
  signal: string | null;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

interface TerminalHandle {
  terminal_id: string;
  argv: string[];
  cwd: string;
  output: string;
  truncated: boolean;
  exitStatus?: ExitStatus;
  done: Promise<SpawnSandboxedResult>;
  controller: AbortController;
  startedAt: number;
}

function extractText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("text" in value)) return undefined;
  const text = value.text;
  return typeof text === "string" ? text : undefined;
}

function previewContent(content: unknown): string {
  return JSON.stringify(content).slice(0, 200);
}

function normalizeContentArray(content: readonly unknown[]): string {
  let result = "";
  for (const item of content) {
    if (typeof item === "string") {
      result += item;
      continue;
    }
    const text = extractText(item);
    if (text !== undefined) {
      result += text;
      continue;
    }
    throw new IoError(
      `invalid array element in content: ${typeof item}. content preview: ${previewContent(content)}`,
    );
  }
  return result;
}

export function normalizeWriteTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return normalizeContentArray(content);
  const text = extractText(content);
  if (text !== undefined) return text;
  throw new IoError(
    `invalid content type: ${typeof content}. content preview: ${previewContent(content)}`,
  );
}

export class WriteToolsExecutor {
  private readonly oneShots = new Map<string, TerminalHandle>();
  private readonly pathLocks = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly opts: WriteToolsExecutorOpts) {}

  async writeTextFile(
    args: { path: string; content: unknown },
    ctx: ToolCallContext,
  ): Promise<{ bytesWritten: number; sha256: string }> {
    const normalizedContent = normalizeWriteTextContent(args.content);
    await this.gate(ctx);
    const real = await this.resolvePath(args.path);
    return this.withPathLock(real, async () => {
      let prev_sha256: string | null = null;
      try {
        const st = await stat(real);
        if (st.isDirectory()) throw new NotAFileError(`path is a directory: ${args.path}`);
        const existing = await readFile(real);
        prev_sha256 = createHash("sha256").update(existing).digest("hex");
      } catch (err) {
        if (err instanceof NotAFileError) throw err;
        if (errorCode(err) !== "ENOENT")
          throw new IoError(`failed to stat ${args.path}: ${errorMessage(err)}`);
      }

      await this.ensureParentDir(args.path, real);

      const tmp = `${real}.tmp.${randomUUID()}`;
      try {
        await writeFile(tmp, normalizedContent, "utf8");
        await rename(tmp, real);
      } catch (err) {
        throw new IoError(`failed to write ${args.path}: ${errorMessage(err)}`);
      }

      const sha256 = createHash("sha256").update(normalizedContent, "utf8").digest("hex");
      const bytesWritten = Buffer.byteLength(normalizedContent, "utf8");

      await this.opts.auditEmitter.emit("fs.write_applied", {
        path: args.path,
        bytes: bytesWritten,
        sha256,
        prev_sha256,
        handoff_id: this.opts.handoffId,
      });
      return { bytesWritten, sha256 };
    });
  }

  /**
   * FIFO in-process mutex keyed on resolved realpath. Serializes the
   * read→transform→rename critical section of writeTextFile/editTextFile
   * against concurrent ACP fs/write dispatches to the same path.
   */
  private async withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.pathLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => next);
    this.pathLocks.set(key, chained);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.pathLocks.get(key) === chained) {
        this.pathLocks.delete(key);
      }
    }
  }

  protected async resolvePath(p: string): Promise<string> {
    try {
      return await resolveInsideWorktree(p, this.opts.worktreeRoot);
    } catch (err) {
      if (!(err instanceof FsPathError)) throw err;
      if (err.code === "outside_worktree") throw new OutsideWorktreeError(err.message);
      if (err.code === "not_found") return await this.resolveMissingPath(p);
      throw new IoError(err.message);
    }
  }

  private async resolveMissingPath(p: string): Promise<string> {
    const worktreeReal = await realpath(resolve(this.opts.worktreeRoot));
    const candidate = isAbsolute(p) ? resolve(p) : resolve(worktreeReal, p);
    const existingReal = await this.findExistingAncestor(candidate);
    if (existingReal) {
      const rel = relative(worktreeReal, existingReal);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new OutsideWorktreeError(`path "${p}" resolves outside worktree`);
      }
    }
    return candidate;
  }

  private async findExistingAncestor(start: string): Promise<string | null> {
    let current = start;
    while (current !== dirname(current)) {
      try {
        return await realpath(current);
      } catch {
        current = dirname(current);
      }
    }
    return null;
  }

  protected async ensureParentDir(userPath: string, resolvedReal: string): Promise<void> {
    const parentDir = dirname(resolvedReal);
    try {
      const parentStat = await stat(parentDir);
      if (parentStat.isDirectory()) return;
      throw new IoError(`parent path is not a directory: ${userPath}`);
    } catch (err) {
      if (err instanceof IoError) throw err;
      if (errorCode(err) !== "ENOENT")
        throw new IoError(`failed to stat parent ${userPath}: ${errorMessage(err)}`);
    }

    const worktreeReal = await realpath(resolve(this.opts.worktreeRoot));
    const relativeTarget = relative(worktreeReal, resolvedReal);
    const parts = relativeTarget.split(path.sep).filter(Boolean);
    if (parts.length > 4) throw new IoError(`parent depth too deep for auto-create: ${userPath}`);
    await mkdir(parentDir, { recursive: true });
  }

  async editTextFile(
    args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
    ctx: ToolCallContext,
  ): Promise<{ bytesAdded: number; bytesRemoved: number; sha256: string }> {
    await this.gate(ctx);
    if (args.old_string === "") throw new EditAmbiguousError("old_string is empty", Infinity);
    const real = await this.resolvePath(args.path);
    return this.withPathLock(real, async () => {
      let existing: string;
      try {
        existing = await readFile(real, "utf8");
      } catch (err) {
        if (errorCode(err) === "ENOENT") throw new EditMissError(`file not found: ${args.path}`, 0);
        throw new IoError(`failed to read ${args.path}: ${errorMessage(err)}`);
      }
      const prev_sha256 = createHash("sha256").update(existing, "utf8").digest("hex");
      const oldBytes = Buffer.byteLength(args.old_string, "utf8");
      const newBytes = Buffer.byteLength(args.new_string, "utf8");

      if (args.old_string === args.new_string) {
        // no-op success; no event
        return { bytesAdded: 0, bytesRemoved: 0, sha256: prev_sha256 };
      }

      const occurrences = existing.split(args.old_string).length - 1;
      if (occurrences === 0)
        throw new EditMissError(
          `old_string not found in ${args.path}`,
          Buffer.byteLength(existing, "utf8"),
        );
      if (occurrences > 1 && !args.replace_all)
        throw new EditAmbiguousError(
          `old_string matches ${String(occurrences)} times`,
          occurrences,
        );

      const next = args.replace_all
        ? existing.split(args.old_string).join(args.new_string)
        : existing.replace(args.old_string, args.new_string);

      const tmp = `${real}.tmp.${randomUUID()}`;
      await writeFile(tmp, next, "utf8");
      await rename(tmp, real);

      const sha256 = createHash("sha256").update(next, "utf8").digest("hex");
      const replacements = args.replace_all ? occurrences : 1;
      const bytesAdded = newBytes * replacements;
      const bytesRemoved = oldBytes * replacements;

      await this.opts.auditEmitter.emit("fs.edit_applied", {
        path: args.path,
        bytes_added: bytesAdded,
        bytes_removed: bytesRemoved,
        sha256,
        prev_sha256,
        handoff_id: this.opts.handoffId,
      });
      return { bytesAdded, bytesRemoved, sha256 };
    });
  }

  async terminalCreate(
    args: { command?: string; argv?: string[]; cwd?: string; output_byte_limit?: number },
    ctx: ToolCallContext,
  ): Promise<{ terminal_id: string }> {
    if (this.oneShots.size >= this.opts.sandboxConfig.maxConcurrent) {
      throw new TerminalCapExceededError(this.opts.sandboxConfig.maxConcurrent);
    }
    await this.gate(ctx);

    const cwd = await this.resolveTerminalCwd(args.cwd);
    const terminal_id = randomUUID();
    const controller = new AbortController();
    const outputMaxBytes = args.output_byte_limit ?? this.opts.sandboxConfig.outputMaxBytes;
    const argv = args.argv ?? ["bash", "-c", args.command ?? ""];

    const done = spawnSandboxed({
      argv: args.argv,
      cmd: args.command,
      cwd,
      timeoutMs: this.opts.sandboxConfig.timeoutMs,
      outputMaxBytes,
      signal: controller.signal,
      path: this.opts.sandboxConfig.path,
    });

    const handle: TerminalHandle = {
      terminal_id,
      argv,
      cwd,
      output: "",
      truncated: false,
      done,
      controller,
      startedAt: Date.now(),
    };
    this.oneShots.set(terminal_id, handle);

    void done
      .then(async (r) => {
        handle.output = r.output;
        handle.truncated = r.truncated;
        handle.exitStatus = { exitCode: r.exitCode, signal: r.signal };
        await this.opts.auditEmitter.emit("terminal.exited", {
          terminal_id,
          exit_code: r.exitCode,
          signal: r.signal,
          output_bytes: Buffer.byteLength(r.output, "utf8"),
          output_truncated: r.truncated,
          duration_ms: r.durationMs,
          handoff_id: this.opts.handoffId,
        });
        if (r.killReason) {
          await this.opts.auditEmitter.emit("terminal.killed", {
            terminal_id,
            reason: r.killReason,
            handoff_id: this.opts.handoffId,
          });
        }
      })
      .catch((err: unknown) => {
        this.opts.logger.error(`terminal tracking failed: ${errorMessage(err)}`);
      });

    await this.opts.auditEmitter.emit("terminal.spawned", {
      terminal_id,
      argv,
      cwd: cwd === this.opts.worktreeRoot ? "/" : path.relative(this.opts.worktreeRoot, cwd),
      env_keys: computeSandboxEnvKeys(),
      handoff_id: this.opts.handoffId,
    });

    return { terminal_id };
  }

  terminalOutput(args: {
    terminal_id: string;
  }): Promise<{ output: string; truncated: boolean; exit_status?: ExitStatus }> {
    const h = this.oneShots.get(args.terminal_id);
    if (!h) return Promise.reject(new TerminalNotFoundError(args.terminal_id));
    return Promise.resolve({
      output: h.output,
      truncated: h.truncated,
      exit_status: h.exitStatus,
    });
  }

  async terminalWaitForExit(args: { terminal_id: string }): Promise<{ exit_status: ExitStatus }> {
    const h = this.oneShots.get(args.terminal_id);
    if (!h) throw new TerminalNotFoundError(args.terminal_id);
    const r = await h.done;
    return { exit_status: { exitCode: r.exitCode, signal: r.signal } };
  }

  async terminalRelease(args: { terminal_id: string }): Promise<void> {
    const h = this.oneShots.get(args.terminal_id);
    if (!h) return;
    if (!h.exitStatus) {
      h.controller.abort();
      try {
        await h.done;
      } catch {
        /* swallow */
      }
    }
    this.oneShots.delete(args.terminal_id);
  }

  async terminalKill(args: { terminal_id: string }): Promise<void> {
    const h = this.oneShots.get(args.terminal_id);
    if (!h) throw new TerminalNotFoundError(args.terminal_id);
    h.controller.abort();
    await this.opts.auditEmitter.emit("terminal.killed", {
      terminal_id: args.terminal_id,
      reason: "operator",
      handoff_id: this.opts.handoffId,
    });
  }

  /** Idempotent. Called from dispatcher cleanup hook. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const h of this.oneShots.values()) {
      if (!h.exitStatus) {
        h.controller.abort();
        await this.opts.auditEmitter.emit("terminal.killed", {
          terminal_id: h.terminal_id,
          reason: "dispatch_end",
          handoff_id: this.opts.handoffId,
        });
      }
    }
    this.oneShots.clear();
  }

  /** Runs the permission callback and throws OperationRejectedError on reject. */
  protected async gate(ctx: ToolCallContext): Promise<void> {
    const decision = await this.opts.permissionCallback(ctx);
    if (decision !== "approve")
      throw new OperationRejectedError(`permission denied: ${ctx.toolName}`);
  }

  /** Test seam — exposes the one-shot map for assertions only. */
  get __oneShotTerminals(): Map<string, TerminalHandle> {
    return this.oneShots;
  }

  private async resolveTerminalCwd(cwdArg?: string): Promise<string> {
    if (!cwdArg || cwdArg === "." || cwdArg === "/") {
      return this.opts.worktreeRoot;
    }

    try {
      return await resolveInsideWorktree(cwdArg, this.opts.worktreeRoot);
    } catch (err) {
      if (err instanceof FsPathError) {
        if (err.code === "outside_worktree") throw new OutsideWorktreeError(err.message);
        throw new IoError(err.message);
      }
      throw new IoError(`bad cwd: ${errorMessage(err)}`);
    }
  }
}
