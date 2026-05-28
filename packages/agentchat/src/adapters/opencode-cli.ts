import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from "../sdk/adapter.js";
import { spawnCliAdapter, spawnCliAdapterStream } from "./cli-spawn.js";
import type { CapacityError } from "./cli-spawn.js";
import type { McpServer } from "./acp-types.js";
import { prepareOpencodeMcpConfigDir } from "./opencode-mcp-config.js";
import { resolveAdapterApiKey } from "./secret.js";
import type { CapturePort } from "../worker/capture-port.js";

export interface OpencodeCliOptions {
  model: string;
  command?: string;
  args?: string[];
  cwd?: string;
  pass_via?: "stdin" | "argv";
  env?: Record<string, string>;
  unset_env?: string[];
  strip_patterns?: string[];
  mcpServers?: McpServer[];
  capturePort?: CapturePort;
}

export class OpencodeCliAdapter implements Adapter {
  readonly kind = "opencode-cli";
  constructor(private readonly opts: OpencodeCliOptions) {}

  private onCapacityError(err: CapacityError): void {
    this.opts.capturePort?.emit({
      kind: "capacity_error",
      provider: err.provider,
      model: err.model,
      raw: err.raw,
    });
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const model = this.opts.model.includes("/") ? this.opts.model : `opencode/${this.opts.model}`;
    const command =
      this.opts.command ?? "~/.opencode/bin/opencode".replace(/^~/, process.env.HOME ?? "");
    const baseArgs = this.opts.args ?? ["run", "--model", model];

    let apiKey = "";
    try {
      apiKey = resolveAdapterApiKey({ apiKeyKeychain: "llamactl/opencode" });
    } catch {
      // Graceful degradation: let the CLI handle missing credentials
    }

    const baseEnv: Record<string, string> = { ...this.opts.env, OPENCODE_API_KEY: apiKey };
    let xdgCleanup: (() => Promise<void>) | null = null;

    if (this.opts.mcpServers && this.opts.mcpServers.length > 0) {
      const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir(this.opts.mcpServers);
      baseEnv.XDG_CONFIG_HOME = xdgConfigHome;
      xdgCleanup = cleanup;
    }

    try {
      const out = await spawnCliAdapter({
        command,
        args: baseArgs,
        prompt: input.prompt,
        signal: input.signal,
        cwd: this.opts.cwd,
        pass_via: this.opts.pass_via ?? "argv",
        env: baseEnv,
        unset_env: this.opts.unset_env,
        strip_patterns: this.opts.strip_patterns,
        onCapacityError: (err) => this.onCapacityError(err),
        eventContext: input.eventContext,
        onEvent: input.onEvent,
      });

      const { text, stderr } = out;
      if (!text.trim()) {
        const markers = [
          "ProviderModelNotFoundError",
          "Error: Model not found",
          "AuthenticationError",
          "Error: API key",
        ];
        const matched = markers.find((m) => stderr.includes(m));
        if (matched || stderr.trim()) {
          const msg = stderr.trim().slice(0, 500);
          throw new Error(`opencode-cli error: ${msg || "empty output"}`);
        }
      }

      return { text };
    } finally {
      if (xdgCleanup) await xdgCleanup();
    }
  }

  async *dispatchStream(input: DispatchInput): AsyncGenerator<DispatchEvent> {
    const model = this.opts.model.includes("/") ? this.opts.model : `opencode/${this.opts.model}`;
    const command =
      this.opts.command ?? "~/.opencode/bin/opencode".replace(/^~/, process.env.HOME ?? "");
    const baseArgs = this.opts.args ?? ["run", "--model", model];

    let apiKey = "";
    try {
      apiKey = resolveAdapterApiKey({ apiKeyKeychain: "llamactl/opencode" });
    } catch {
      // Graceful degradation: let the CLI handle missing credentials
    }

    const baseEnv: Record<string, string> = { ...this.opts.env, OPENCODE_API_KEY: apiKey };
    let xdgCleanup: (() => Promise<void>) | null = null;

    if (this.opts.mcpServers && this.opts.mcpServers.length > 0) {
      const { xdgConfigHome, cleanup } = await prepareOpencodeMcpConfigDir(this.opts.mcpServers);
      baseEnv.XDG_CONFIG_HOME = xdgConfigHome;
      xdgCleanup = cleanup;
    }

    try {
      yield* spawnCliAdapterStream({
        command,
        args: baseArgs,
        prompt: input.prompt,
        signal: input.signal,
        cwd: this.opts.cwd,
        pass_via: this.opts.pass_via ?? "argv",
        env: baseEnv,
        unset_env: this.opts.unset_env,
        strip_patterns: this.opts.strip_patterns,
        onCapacityError: (err) => this.onCapacityError(err),
        eventContext: input.eventContext,
        onEvent: input.onEvent,
      });
    } finally {
      if (xdgCleanup) await xdgCleanup();
    }
  }
}
