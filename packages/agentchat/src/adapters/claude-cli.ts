import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from "../sdk/adapter.js";
import { spawnCliAdapter, spawnCliAdapterStream } from "./cli-spawn.js";
import type { CapacityError } from "./cli-spawn.js";
import type { CapturePort } from "../worker/capture-port.js";

export interface ClaudeCliOptions {
  command: string;
  args?: string[];
  cwd?: string;
  pass_via?: "stdin" | "argv";
  env?: Record<string, string>;
  unset_env?: string[];
  strip_patterns?: string[];
  capturePort?: CapturePort;
}

export class ClaudeCliAdapter implements Adapter {
  readonly kind = "claude-cli";
  constructor(private readonly opts: ClaudeCliOptions) {}

  private onCapacityError(err: CapacityError): void {
    this.opts.capturePort?.emit({
      kind: "capacity_error",
      provider: err.provider,
      model: err.model,
      raw: err.raw,
    });
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const { text } = await spawnCliAdapter({
      command: this.opts.command,
      args: this.opts.args ?? ["code", "--no-tty"],
      prompt: input.prompt,
      signal: input.signal,
      cwd: this.opts.cwd,
      pass_via: this.opts.pass_via,
      env: this.opts.env,
      unset_env: this.opts.unset_env,
      strip_patterns: this.opts.strip_patterns,
      onCapacityError: (err) => this.onCapacityError(err),
      eventContext: input.eventContext,
      onEvent: input.onEvent,
    });
    return { text };
  }

  async *dispatchStream(input: DispatchInput): AsyncGenerator<DispatchEvent> {
    yield* spawnCliAdapterStream({
      command: this.opts.command,
      args: this.opts.args ?? ["code", "--no-tty"],
      prompt: input.prompt,
      signal: input.signal,
      cwd: this.opts.cwd,
      pass_via: this.opts.pass_via,
      env: this.opts.env,
      unset_env: this.opts.unset_env,
      strip_patterns: this.opts.strip_patterns,
      onCapacityError: (err) => this.onCapacityError(err),
      eventContext: input.eventContext,
      onEvent: input.onEvent,
    });
  }
}
