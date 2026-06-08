import type { Logger } from "@penumbra/core";
import { resolveInsideWorktree, FsPathError } from "@penumbra/core";
import type { PermissionCallback } from "./permission-callback.js";
import type { ToolCallContext } from "../sdk/adapter.js";
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
import { spawnSandboxed, type SpawnSandboxedResult } from "./sandbox-spawn.js";
import type { SandboxConfig } from "./sandbox-config.js";
import { createHash, randomUUID } from "node:crypto";
import { writeFile, readFile, rename, stat, mkdir, realpath } from "node:fs/promises";
import path, { dirname, resolve, isAbsolute, relative } from "node:path";

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

export class WriteToolsExecutor {
  private readonly oneShots = new Map<string, TerminalHandle>();
  private disposed = false;

  constructor(private readonly opts: WriteToolsExecutorOpts) {}

  async writeTextFile(
    args: { path: string; content: string },
    ctx: ToolCallContext,
  ): Promise<{ bytesWritten: number; sha256: string }> {
    await this.gate(ctx);
    const real = await this.resolvePath(args.path);
    let prev_sha256: string | null = null;
    try {
      const st = await stat(real);
      if (st.isDirectory()) throw new NotAFileError(`path is a directory: ${args.path}`);
      const existing = await readFile(real);
      prev_sha256 = createHash("sha256").update(existing).digest("hex");
    } catch (err: any) {
      if (err instanceof NotAFileError) throw err;
      if (err?.code !== "ENOENT")
        throw new IoError(`failed to stat ${args.path}: ${err?.message ?? err}`);
    }

    await this.ensureParentDir(args.path, real);

    const tmp = `${real}.tmp.${randomUUID()}`;
    try {
      await writeFile(tmp, args.content, "utf8");
      await rename(tmp, real);
    } catch (err: any) {
      throw new IoError(`failed to write ${args.path}: ${err?.message ?? err}`);
    }

    const sha256 = createHash("sha256").update(args.content, "utf8").digest("hex");
    const bytesWritten = Buffer.byteLength(args.content, "utf8");

    await this.opts.auditEmitter.emit("fs.write_applied", {
      path: args.path,
      bytes: bytesWritten,
      sha256,
      prev_sha256,
      handoff_id: this.opts.handoffId,
    });
    return { bytesWritten, sha256 };
  }

  protected async resolvePath(p: string): Promise<string> {
    try {
      return await resolveInsideWorktree(p, this.opts.worktreeRoot);
    } catch (err: any) {
      if (err instanceof FsPathError) {
        if (err.code === "outside_worktree") throw new OutsideWorktreeError(err.message);
        if (err.code === "not_found") {
          const worktreeReal = await realpath(resolve(this.opts.worktreeRoot));
          const candidate = isAbsolute(p) ? resolve(p) : resolve(worktreeReal, p);

          let current = candidate;
          let existingReal: string | null = null;
          while (current !== dirname(current)) {
            try {
              existingReal = await realpath(current);
              break;
            } catch {
              current = dirname(current);
            }
          }

          if (existingReal) {
            const rel = relative(worktreeReal, existingReal);
            if (rel.startsWith("..") || isAbsolute(rel)) {
              throw new OutsideWorktreeError(`path "${p}" resolves outside worktree`);
            }
          }
          return candidate;
        }
        throw new IoError(err.message);
      }
      throw err;
    }
  }

  protected async ensureParentDir(userPath: string, resolvedReal: string): Promise<void> {
    const parentDir = dirname(resolvedReal);
    try {
      const parentStat = await stat(parentDir);
      if (parentStat.isDirectory()) return;
      throw new IoError(`parent path is not a directory: ${userPath}`);
    } catch (err: any) {
      if (err instanceof IoError) throw err;
      if (err?.code !== "ENOENT")
        throw new IoError(`failed to stat parent ${userPath}: ${err?.message ?? err}`);
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
    let existing: string;
    try {
      existing = await readFile(real, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") throw new EditMissError(`file not found: ${args.path}`, 0);
      throw new IoError(`failed to read ${args.path}: ${err?.message ?? err}`);
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
      throw new EditAmbiguousError(`old_string matches ${occurrences} times`, occurrences);

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
      .catch((err) => {
        this.opts.logger.error(
          `terminal tracking failed: ${String((err as Error)?.message ?? err)}`,
        );
      });

    await this.opts.auditEmitter.emit("terminal.spawned", {
      terminal_id,
      argv,
      cwd: cwd === this.opts.worktreeRoot ? "/" : path.relative(this.opts.worktreeRoot, cwd),
      env_keys: ["PATH", "HOME", "CI", "TERM"],
      handoff_id: this.opts.handoffId,
    });

    return { terminal_id };
  }

  async terminalOutput(args: {
    terminal_id: string;
  }): Promise<{ output: string; truncated: boolean; exit_status?: ExitStatus }> {
    const h = this.oneShots.get(args.terminal_id);
    if (!h) throw new TerminalNotFoundError(args.terminal_id);
    return { output: h.output, truncated: h.truncated, exit_status: h.exitStatus };
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
      throw new IoError(`bad cwd: ${String((err as Error)?.message ?? err)}`);
    }
  }
}
