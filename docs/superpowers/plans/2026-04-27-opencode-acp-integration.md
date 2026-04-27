# OpenCode Integration: Path A (cli-spawn) shipped, Path B (ACP) design

> **Status**: Path A landed in commit `c81cb41` (opencode-cli adapter + 5 oc-* agents). Path B (ACP) is the strategic follow-up.
>
> **Source**: gemini design dispatch (handoff `286166d5`, 2026-04-27).
>
> **Caveat**: Citations and recommendations are gemini's; verify before implementation.

---
This is the design document for the OpenCode Go integration.

# OpenCode Go Integration Design

## (A) Agentchat CLI Adapter Inventory

The existing CLI adapters rely on a shared subprocess spawning utility, with thin wrapper classes that provide defaults.

**Shared Spawner (`packages/agentchat/src/adapters/cli-spawn.ts`)**
*   **Spawn command:** `Bun.spawn([opts.command, ...finalArgs], ...)` (Line 26).
*   **Env-var injection:** Merges `process.env` with `opts.env`, then deletes any keys specified in `opts.unset_env` (Lines 21-22).
*   **Stdin/Stdout handling:** 
    *   If `opts.pass_via === 'argv'`, the prompt is appended to the arguments list (Line 19). Otherwise, it writes to stdin via `proc.stdin.write(opts.prompt)` (Line 32).
    *   Stdout is captured entirely into memory: `const rawText = await new Response(proc.stdout).text();` (Line 35).
    *   Raw output is filtered through regex patterns to remove chatty wrapper noise: `applyStripPatterns(rawText, opts.strip_patterns)` (Lines 13-17, 40).
*   **Exit codes / errors:** Awaits `proc.exited`. If the exit code `!== 0`, it throws an `Error` containing the exit code and the captured stderr (Lines 37-39).

**Existing Adapters**
*   **`claude-cli`** (`packages/agentchat/src/adapters/claude-cli.ts`): Passes `command` and defaults to `args: ['code', '--no-tty']` (Line 19).
*   **`codex-cli`** (`packages/agentchat/src/adapters/codex-cli.ts`): Passes `command` and defaults to `args: []` (Line 18).

## (B) OpenCode CLI Surface for Headless Use

*   **`opencode run`**:
    *   **Message passing:** Accepts the prompt via positional arguments (`[message..]`), mapping cleanly to `pass_via: 'argv'`.
    *   **Response format:** Returns standard text to stdout by default. Can stream raw JSON events via `--format json`.
    *   **Model selection:** Set via the `-m, --model <provider/model>` flag.
    *   **Env vars / Flags:** Honors the `OPENCODE_API_KEY` environment variable. The `--pure` flag disables external plugins, which is ideal for a deterministic agent environment.
*   **`opencode serve`**:
    *   Starts a headless server taking `--port` and `--hostname`.
    *   It implements an OpenCode-native API, not a standard OpenAI-compatible `/v1/chat/completions` endpoint.
    *   Auth would likely be handled via basic auth (`--password`).
*   **`opencode acp`**:
    *   Starts a server speaking the Agent Client Protocol (ACP).
    *   It is a network server (TCP/HTTP based, taking `--port` and `--hostname`), not a simple stdin/stdout JSON-RPC interface.

## (C) llamactl Credential Brokering Options

The `llamactl` CLI binding schema is defined in `/Volumes/WorkSSD/repos/personal/llamactl/packages/remote/src/config/schema.ts` (Lines 85-110), and bound to agent nodes via `cli: z.array(CliBindingSchema).optional()` (Line 270). 

We have three viable patterns to broker the keychain credential to the agentchat fleet:

1.  **Add a new llamactl util `getKeychainSecret`**: Inject `OPENCODE_API_KEY` into spawned CLI agents via a new `env_keychain:` field on the agent's `cli:` binding.
2.  **Agentchat directly calls `security find-generic-password`**: Agentchat resolves the keychain item at spawn time. llamactl's role remains purely metadata (providing the `service/account` string in config).
3.  **llamactl serves `/v1/keys/<name>`**: Agentchat fetches the secret via HTTP at spawn time.

**Evaluation & Selection:**
I recommend **Pattern 2**. 
*   *Tradeoffs:* Pattern 3 introduces strict runtime coupling (agentchat fails if the llamactl control plane is down). Pattern 1 assumes llamactl directly supervises the agentchat worker processes, which violates the standalone fleet daemon architecture. 
*   *Why Pattern 2:* By having agentchat directly shell out to `security find-generic-password`, we decouple the processes completely. `llamactl` acts as the source of truth for the *metadata* (which keychain item to use), but the runtime secret resolution happens exactly where it is needed, right before the subprocess is spawned.

## (D) Recommended Integration Shape

**Recommendation: Path 1 (opencode CLI subprocess per-message)**

*Reasoning:* The prompt explicitly states "Direct HTTP to Zen is NOT the right integration; CLI subprocess is". Since `opencode serve` uses a proprietary API, building a custom HTTP client adapter would be a significant lift. Similarly, `opencode acp` requires implementing a new emerging protocol. Path 1 perfectly leverages the existing, battle-tested `cli-spawn.ts` infrastructure. The per-turn startup latency of shelling out is an acceptable tradeoff for the simplicity and guaranteed compatibility of using the native OpenCode CLI to interface with the Go tier.

## (E) Agent Fleet Map

Additions to `~/.config/agentchat/agentchat.yaml`:

```yaml
agents:
  - name: oc-gpt-5.2-codex
    adapter: opencode-cli
    roles: [executor]
    options:
      command: /Users/acordeiro/.opencode/bin/opencode
      args: ["run", "-m", "zen/gpt-5.2-codex", "--pure"]
      pass_via: argv
      keychain_ref: "llamactl/opencode"
      env_var: "OPENCODE_API_KEY"

  - name: oc-claude-4.6-opus
    adapter: opencode-cli
    roles: [planner, reviewer]
    options:
      command: /Users/acordeiro/.opencode/bin/opencode
      args: ["run", "-m", "zen/claude-4.6-opus", "--pure"]
      pass_via: argv
      keychain_ref: "llamactl/opencode"
      env_var: "OPENCODE_API_KEY"

  - name: oc-kimi-k2
    adapter: opencode-cli
    roles: [executor]
    options:
      command: /Users/acordeiro/.opencode/bin/opencode
      args: ["run", "-m", "zen/kimi-k2", "--pure"]
      pass_via: argv
      keychain_ref: "llamactl/opencode"
      env_var: "OPENCODE_API_KEY"
```
*(Roles are assigned based on model capability: Opus for heavy reasoning/planning, Codex/Kimi for fast, context-heavy execution).*

## (F) Implementation Plan

*   **Commit 1: Add keychain resolution to `cli-spawn.ts`**
    *   **Files:** `packages/agentchat/src/adapters/cli-spawn.ts`
    *   **Action:** Update `SpawnOpts` to accept `keychain_ref?: string` and `env_var?: string`. Inside `spawnCliAdapter`, if `keychain_ref` is present, use `execSync('security find-generic-password -a <account> -s <service> -w')` to fetch the secret and inject it into `mergedEnv[opts.env_var]`.
    *   **Acceptance:** You can verify by writing a simple unit test that spawns `env` or `printenv`, passes a dummy keychain ref, and asserts the injected variable appears in the output.
*   **Commit 2: Create `opencode-cli` adapter**
    *   **Files:** `packages/agentchat/src/adapters/opencode-cli.ts`
    *   **Action:** Implement the `Adapter` interface. It will call `spawnCliAdapter` mapping the specific `keychain_ref` and `env_var` options.
    *   **Acceptance:** You can verify by compiling the `agentchat` package and confirming no type errors exist.
*   **Commit 3: Register adapter and update configuration**
    *   **Files:** `packages/agentchat/src/adapters/registry.ts`, `~/.config/agentchat/agentchat.yaml`
    *   **Action:** Export `opencode-cli` in the registry so the factory can construct it. Add the new agent definitions to the YAML configuration.
    *   **Acceptance:** You can verify by running `agentchat oc-gpt-5.2-codex "echo hello"` from the terminal and receiving a valid model response.

## (G) Risks and Unknowns

*   **Argument Length Limits (`E2BIG`):** We are passing the prompt via positional arguments (`pass_via: argv`). While macOS has a large `ARG_MAX` (~1MB), massive code diffs or context payloads could exceed this limit. We don't currently know if `opencode run` gracefully falls back to reading `stdin` if no message is provided.
*   **CLI Output Noise:** `opencode run` might output ANSI escape codes, progress spinners, or "Thinking..." text intermingled with the final response. If so, we will need to utilize `strip_patterns` or switch to `--format json` and parse the raw event stream.
*   **Keychain Access Prompts:** If the macOS keychain item for `llamactl/opencode` is not configured with "Allow all applications to access this item", the `security` CLI command will trigger a native UI prompt asking for a password or TouchID. This will block the headless daemon indefinitely. The user must configure the keychain item correctly beforehand.

 @docs/superpowers/notes/2026-04-27-penumbra-mcp-friction-review.md chain-terminated

