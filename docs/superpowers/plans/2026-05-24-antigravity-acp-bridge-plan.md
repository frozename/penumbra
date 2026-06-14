# Antigravity ACP Bridge — Implementation Plan

**Date**: 2026-05-24
**Status**: ABANDONED 2026-05-23 — ToS risk
**Abandoned reason**: Both this plan (patch gemini-cli bundle) and the prior shim plan (wrap `agy --print`) route through Google's internal `daily-cloudcode-pa.googleapis.com` API via unofficial means. Even though openab PR #865 demonstrated the technique, operating against an internal API outside the documented `agy` CLI surface risks violating Antigravity ToS and account revocation. Not worth the blast radius for fleet routing convenience.
**If revisited**: Wait for `agy --acp` upstream support (tracked at `google-antigravity/antigravity-cli#31`) or a first-party Antigravity API key. Until then, stay on Code Assist (`gemini-acp-pro`) + paid-API roles for the fleet.

---

> Historical note: the rest of this file is the synthesized plan from the 2026-05-23 adversarial fan-out, preserved for archaeology. **Do not execute.**

**Supersedes**: [`docs/superpowers/plans/2026-05-20-agy-acp-shim.md`](2026-05-20-agy-acp-shim.md) — that plan wrapped `agy --print` as a synthetic ACP shim. This plan uses the openab PR #865 technique (patch gemini-cli's bundled OAuth constants + endpoint) instead, which is cheaper and keeps the full ACP tool surface. The shim approach remains a fallback if Phase 0 fails.
**Derivation**: Synthesized from architect + simplifier + risk persona drafts at `.penumbra/reviews/2026-05-23T19-53-46.526Z/`. Architect's TDD detail kept verbatim; synthesizer's cut-list and conflict notes merged below.

## Overview

Route `gemini --acp` at `daily-cloudcode-pa.googleapis.com` (Antigravity backend) by patching
gemini-cli's bundled JS constants — client_id, client_secret, and API endpoint — to Antigravity
values. This gives the agentchat fleet Gemini 3.5 Flash and (possibly) Claude 4.6 on a separate
subscription quota with full ACP tool surface, sidestepping recurring `MODEL_CAPACITY_EXHAUSTED`
errors on the Code Assist path.

## Integration Surface

| Component | Role | Committed? |
|---|---|---|
| `scripts/antigravity/patch-bundle.sh` | Patches bundle JS constants in-place; stamped for idempotence | Yes |
| `scripts/antigravity/setup.sh` | One-time install: copies Homebrew 0.42.0 → vendor dir, patches, writes shim | Yes |
| `scripts/antigravity/fixtures/chunk-synthetic.js` | Fake JS chunk with synthetic OAuth constants (unit test fixture) | Yes |
| `scripts/antigravity/patch-bundle.test.ts` | Bun unit tests for patch contract | Yes |
| `scripts/antigravity/agentchat-health.test.ts` | Bun tests asserting shim + creds exist post-setup | Yes |
| `~/.penumbra/vendor/gemini-antigravity/` | Patched side-by-side install — never overwrites Homebrew copy | No (runtime) |
| `~/.penumbra/bin/gemini-antigravity` | Wrapper shim; sets `HOME=~/.penumbra/home-antigravity` for cred isolation | No (runtime) |
| `~/.penumbra/home-antigravity/.gemini/` | Isolated OAuth creds dir; never touches `~/.gemini/` (Code Assist) | No (runtime) |
| `~/.penumbra/secrets.env` | `ANTIGRAVITY_OAUTH_CLIENT_ID` + `_CLIENT_SECRET`; chmod 600; not committed | No (secret) |
| `agentchat.yaml` | New roles: `antigravity-acp-pro`, `antigravity-acp-flash`, `antigravity-acp-claude-4-6` | Yes |

### Schema / contract

- No daemon schema changes. Uses existing `stdio-acp` adapter protocol unchanged.
- No new npm/bun dependencies. Patch logic is pure bash.
- Tests use `Bun.spawnSync` against the bash script; no new test framework.
- The `HOME` env override in the shim is the sole runtime mechanism for cred isolation.
- Secrets are needed at **patch time** (baked into bundle JS); agentchat.yaml needs only `HOME`.

### Package boundaries

The three layers that must not bleed into each other:

```
[agentchat.yaml entry]
    → shim (~/.penumbra/bin/gemini-antigravity)
        → HOME=~/.penumbra/home-antigravity (isolated creds)
        → node ~/.penumbra/vendor/gemini-antigravity/bin/gemini.js --acp
            → patched bundle (daily-cloudcode-pa.googleapis.com + Antigravity OAuth)
```

The Homebrew install at `/opt/homebrew/Cellar/gemini-cli/0.42.0/...` is never modified.
The regular `gemini-acp-pro` role (pointing at unpatched Homebrew binary) is never replaced until
Antigravity parity is confirmed.

---

## Phase 0: OAuth Bootstrap Spike

**Status**: MUST COMPLETE BEFORE Phase 1+. All subsequent phases assume interactive auth works.

**The unknown**: Does `gemini auth` succeed when the bundle's OAuth client_id/secret are replaced
with Antigravity values? Do redirect URIs, grant scopes, and token formats survive the patch?

### Spike procedure (manual, ~1h)

```bash
# 1. Create disposable test copy
cp -r /opt/homebrew/Cellar/gemini-cli/0.42.0/libexec/lib/node_modules/@google/gemini-cli \
  /tmp/gemini-ag-test

# 2. Find the bundle directory (adjust if layout differs)
find /tmp/gemini-ag-test -name "chunk-*.js" | head -3
find /tmp/gemini-ag-test -name "*.js" -path "*/dist/*" | head -5

# 3. Verify all three constants are discoverable
grep -rl "[0-9]\+-[a-z0-9]\+\.apps\.googleusercontent\.com" /tmp/gemini-ag-test
grep -rl "GOCSPX-[A-Za-z0-9_-]\+" /tmp/gemini-ag-test
grep -rl "cloudcode-pa\.googleapis\.com" /tmp/gemini-ag-test

# 4. Extract originals (record these — needed to write test fixture)
grep -roh "[0-9]\+-[a-z0-9]\+\.apps\.googleusercontent\.com" /tmp/gemini-ag-test | head -1
grep -roh "GOCSPX-[A-Za-z0-9_-]\+" /tmp/gemini-ag-test | head -1

# 5. Manual patch (replace with Antigravity values from secrets.env)
source ~/.penumbra/secrets.env
find /tmp/gemini-ag-test -name "*.js" | xargs sed -i '' \
  -e "s|<ORIG_CLIENT_ID>|${ANTIGRAVITY_OAUTH_CLIENT_ID}|g" \
  -e "s|<ORIG_CLIENT_SECRET>|${ANTIGRAVITY_OAUTH_CLIENT_SECRET}|g" \
  -e "s|cloudcode-pa\.googleapis\.com|daily-cloudcode-pa.googleapis.com|g"

# 6. Auth with isolated HOME
mkdir -p /tmp/gemini-ag-home/.gemini
HOME=/tmp/gemini-ag-home node /tmp/gemini-ag-test/bin/gemini.js auth

# 7. Verify creds written to isolated dir (NOT ~/.gemini/)
cat /tmp/gemini-ag-home/.gemini/oauth_creds.json
ls ~/.gemini/  # must be unchanged

# 8. ACP initialize handshake smoke
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}' \
  | HOME=/tmp/gemini-ag-home node /tmp/gemini-ag-test/bin/gemini.js --acp
# Expect: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":...,"serverInfo":...}}

# 9. Check model selection (does GEMINI_MODEL env var work?)
GEMINI_MODEL=gemini-2.5-flash HOME=/tmp/gemini-ag-home \
  node /tmp/gemini-ag-test/bin/gemini.js --acp
# Send initialize + a simple tools/list; observe what model-name appears in responses
```

### Gate decision

| Outcome | Path |
|---|---|
| Auth completes; `initialize` returns valid response | Proceed to Phase 1 |
| Auth completes; ACP fails with model/API error | Investigate model flag; may need `--model` arg or different env var |
| Auth fails (`invalid_client`, bad `redirect_uri`) | Antigravity creds require app pre-registration; investigate source |
| Constants not found in 0.42.0 bundle | Adjust regex or bundle path; check `dist/` vs `build/` vs `lib/` |
| `gemini.js` entry point not at `bin/gemini.js` | Find correct entry; update setup.sh accordingly |

**Phase 0 is done when**: a manually-patched binary + isolated HOME completes `gemini auth`
AND successfully exchanges an ACP `initialize` / `initialized` pair without error.

Record during spike:
- Actual bundle directory path (needed for fixture and setup.sh)
- Actual entry point path (needed for shim)
- Env var or flag for model selection (needed for Phase 5)
- Whether Claude 4.6 model name is accepted by the Antigravity backend

---

## Phase 1: Patch Script Contract (RED)

**Goal**: Commit tests that define the patch contract before any implementation exists.

### `scripts/antigravity/fixtures/chunk-synthetic.js`

A minimal fake JS bundle chunk containing all three target constants. Use values that match
the real regexes but are obviously synthetic:

```javascript
// Synthetic gemini-cli bundle chunk for patch testing
(function(){
  var CLIENT_ID = "123456789-abcdefghijklmnop.apps.googleusercontent.com";
  var CLIENT_SECRET = "GOCSPX-SyntheticSecretForTestingOnly";
  var API_BASE = "https://cloudcode-pa.googleapis.com/v1";
  var OTHER_CONST = "some-other-value-that-must-not-change";
  module.exports = { CLIENT_ID, CLIENT_SECRET, API_BASE, OTHER_CONST };
})();
```

### `scripts/antigravity/patch-bundle.test.ts`

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PATCH_SCRIPT = join(import.meta.dir, "patch-bundle.sh");
const FIXTURE = join(import.meta.dir, "fixtures", "chunk-synthetic.js");

const ORIG_CLIENT_ID = "123456789-abcdefghijklmnop.apps.googleusercontent.com";
const ORIG_CLIENT_SECRET = "GOCSPX-SyntheticSecretForTestingOnly";
const AG_CLIENT_ID = "987654321-antigravitytest.apps.googleusercontent.com";
const AG_CLIENT_SECRET = "GOCSPX-AntigravitySecretForTest12345";
const OTHER_CONST = "some-other-value-that-must-not-change";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ag-patch-test-"));
  cpSync(FIXTURE, join(tmpDir, "chunk-0.js"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runPatch(overrides: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", PATCH_SCRIPT], {
    env: {
      GEMINI_BUNDLE_DIR: tmpDir,
      ANTIGRAVITY_OAUTH_CLIENT_ID: AG_CLIENT_ID,
      ANTIGRAVITY_OAUTH_CLIENT_SECRET: AG_CLIENT_SECRET,
      GEMINI_CLI_VERSION: "0.42.0",
      PATH: process.env.PATH ?? "",
      ...overrides,
    },
  });
}

test("replaces client_id in chunk", () => {
  expect(runPatch().exitCode).toBe(0);
  const src = readFileSync(join(tmpDir, "chunk-0.js"), "utf8");
  expect(src).not.toContain(ORIG_CLIENT_ID);
  expect(src).toContain(AG_CLIENT_ID);
});

test("replaces client_secret in chunk", () => {
  expect(runPatch().exitCode).toBe(0);
  const src = readFileSync(join(tmpDir, "chunk-0.js"), "utf8");
  expect(src).not.toContain(ORIG_CLIENT_SECRET);
  expect(src).toContain(AG_CLIENT_SECRET);
});

test("replaces endpoint in chunk", () => {
  expect(runPatch().exitCode).toBe(0);
  const src = readFileSync(join(tmpDir, "chunk-0.js"), "utf8");
  expect(src).not.toContain("cloudcode-pa.googleapis.com");
  expect(src).toContain("daily-cloudcode-pa.googleapis.com");
});

test("does not corrupt unrelated constants", () => {
  expect(runPatch().exitCode).toBe(0);
  const src = readFileSync(join(tmpDir, "chunk-0.js"), "utf8");
  expect(src).toContain(OTHER_CONST);
});

test("is idempotent — second run produces identical output", () => {
  runPatch();
  const after1 = readFileSync(join(tmpDir, "chunk-0.js"), "utf8");
  expect(runPatch().exitCode).toBe(0);
  const after2 = readFileSync(join(tmpDir, "chunk-0.js"), "utf8");
  expect(after1).toBe(after2);
});

test("writes stamp file after first patch", () => {
  runPatch();
  const stamp = join(tmpDir, ".antigravity-patched-0.42.0");
  expect(Bun.file(stamp).size).toBeGreaterThan(0);
});

test("skips re-patch when stamp present", () => {
  runPatch();
  // Corrupt the chunk post-patch (simulate external change)
  const chunkPath = join(tmpDir, "chunk-0.js");
  writeFileSync(chunkPath, "corrupted");
  // Second run should skip (stamp exists) and exit 0
  expect(runPatch().exitCode).toBe(0);
  // File should still be corrupted — patch was skipped
  expect(readFileSync(chunkPath, "utf8")).toBe("corrupted");
});

test("fails fast when client_id constant not found in any chunk", () => {
  writeFileSync(join(tmpDir, "chunk-0.js"), `console.log("no constants here");`);
  const result = runPatch();
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("client_id");
});

test("fails fast when endpoint constant not found", () => {
  // Has client_id but no endpoint
  writeFileSync(join(tmpDir, "chunk-0.js"),
    `var x = "${ORIG_CLIENT_ID}"; var y = "${ORIG_CLIENT_SECRET}";`);
  const result = runPatch();
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("cloudcode-pa");
});

test("fails when ANTIGRAVITY_OAUTH_CLIENT_ID is unset", () => {
  const result = runPatch({ ANTIGRAVITY_OAUTH_CLIENT_ID: "" });
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("ANTIGRAVITY_OAUTH_CLIENT_ID");
});

test("fails when ANTIGRAVITY_OAUTH_CLIENT_SECRET is unset", () => {
  const result = runPatch({ ANTIGRAVITY_OAUTH_CLIENT_SECRET: "" });
  expect(result.exitCode).not.toBe(0);
});
```

**RED check**: `bun test scripts/antigravity/patch-bundle.test.ts` — all 11 tests fail
(`patch-bundle.sh: No such file or directory`).

---

## Phase 2: Patch Script Implementation (GREEN)

**Goal**: Write `scripts/antigravity/patch-bundle.sh` so all Phase 1 tests pass.

### `scripts/antigravity/patch-bundle.sh`

```bash
#!/usr/bin/env bash
# Patches gemini-cli bundle JS constants to point at the Antigravity backend.
# Run once per GEMINI_CLI_VERSION; stamped for idempotence.
set -euo pipefail

# Fail-fast on missing required inputs
: "${ANTIGRAVITY_OAUTH_CLIENT_ID:?ANTIGRAVITY_OAUTH_CLIENT_ID must be set}"
: "${ANTIGRAVITY_OAUTH_CLIENT_SECRET:?ANTIGRAVITY_OAUTH_CLIENT_SECRET must be set}"
: "${GEMINI_BUNDLE_DIR:?GEMINI_BUNDLE_DIR must be set}"
: "${GEMINI_CLI_VERSION:?GEMINI_CLI_VERSION must be set}"

STAMP="$GEMINI_BUNDLE_DIR/.antigravity-patched-$GEMINI_CLI_VERSION"

if [[ -f "$STAMP" ]]; then
  echo "Bundle already patched for version $GEMINI_CLI_VERSION — skipping." >&2
  exit 0
fi

# Discover chunks containing client_id pattern
CLIENT_ID_MATCH=$(grep -rl \
  "[0-9]*-[a-z0-9]*\.apps\.googleusercontent\.com" \
  "$GEMINI_BUNDLE_DIR" 2>/dev/null || true)

if [[ -z "$CLIENT_ID_MATCH" ]]; then
  echo "ERROR: client_id constant ([0-9]+-[a-z0-9]+.apps.googleusercontent.com)" \
    "not found under GEMINI_BUNDLE_DIR=$GEMINI_BUNDLE_DIR" >&2
  echo "ERROR: Verify GEMINI_CLI_VERSION=$GEMINI_CLI_VERSION and bundle path." >&2
  exit 1
fi

# Discover chunks containing endpoint
ENDPOINT_MATCH=$(grep -rl \
  "cloudcode-pa\.googleapis\.com" \
  "$GEMINI_BUNDLE_DIR" 2>/dev/null || true)

if [[ -z "$ENDPOINT_MATCH" ]]; then
  echo "ERROR: endpoint constant (cloudcode-pa.googleapis.com)" \
    "not found under GEMINI_BUNDLE_DIR=$GEMINI_BUNDLE_DIR" >&2
  exit 1
fi

# Extract the original client_id value (first match across all JS files)
ORIG_CLIENT_ID=$(grep -roh \
  "[0-9][0-9]*-[a-z0-9]*\.apps\.googleusercontent\.com" \
  "$GEMINI_BUNDLE_DIR" 2>/dev/null | head -1)

if [[ -z "$ORIG_CLIENT_ID" ]]; then
  echo "ERROR: Regex matched a file but could not extract client_id value." >&2
  exit 1
fi

# Extract original client_secret (may be absent in some builds — not fatal)
ORIG_CLIENT_SECRET=$(grep -roh \
  "GOCSPX-[A-Za-z0-9_-]*" \
  "$GEMINI_BUNDLE_DIR" 2>/dev/null | head -1 || true)

# Apply all patches across every *.js under GEMINI_BUNDLE_DIR
find "$GEMINI_BUNDLE_DIR" -name "*.js" -print0 | \
while IFS= read -r -d '' f; do
  sed -i '' \
    -e "s|${ORIG_CLIENT_ID}|${ANTIGRAVITY_OAUTH_CLIENT_ID}|g" \
    ${ORIG_CLIENT_SECRET:+-e "s|${ORIG_CLIENT_SECRET}|${ANTIGRAVITY_OAUTH_CLIENT_SECRET}|g"} \
    -e "s|cloudcode-pa\.googleapis\.com|daily-cloudcode-pa.googleapis.com|g" \
    "$f" 2>/dev/null || true
done

# Stamp
printf "%s" "$GEMINI_CLI_VERSION" > "$STAMP"
echo "Patched $GEMINI_CLI_VERSION in $GEMINI_BUNDLE_DIR" >&2
```

**GREEN check**: `bun test scripts/antigravity/patch-bundle.test.ts` — all 11 tests pass.

---

## Phase 3: Side-by-Side Install + Wrapper Shim

**Goal**: Produce a dedicated, patched install at `~/.penumbra/vendor/gemini-antigravity/`
that does not touch the Homebrew install used by `gemini-acp-pro`.

### Failing test (RED)

```typescript
// scripts/antigravity/agentchat-health.test.ts
import { test, expect } from "bun:test";
import { existsSync } from "fs";

const HOME = process.env.HOME!;

test("setup.sh: wrapper shim exists and is executable", () => {
  const shim = `${HOME}/.penumbra/bin/gemini-antigravity`;
  expect(existsSync(shim)).toBe(true);
  const stat = Bun.spawnSync(["test", "-x", shim]);
  expect(stat.exitCode).toBe(0);
});

test("setup.sh: isolated HOME dir exists", () => {
  expect(existsSync(`${HOME}/.penumbra/home-antigravity/.gemini`)).toBe(true);
});

test("setup.sh: vendor dir has stamp at version 0.42.0", () => {
  const stamp = `${HOME}/.penumbra/vendor/gemini-antigravity/.antigravity-patched-0.42.0`;
  expect(existsSync(stamp)).toBe(true);
});

test("gemini-antigravity --version exits 0", () => {
  const shim = `${HOME}/.penumbra/bin/gemini-antigravity`;
  const result = Bun.spawnSync([shim, "--version"], {
    env: { HOME: `${HOME}/.penumbra/home-antigravity`, PATH: process.env.PATH ?? "" },
  });
  expect(result.exitCode).toBe(0);
});
```

These fail before `setup.sh` is run.

### `scripts/antigravity/setup.sh`

```bash
#!/usr/bin/env bash
# One-time setup: copy + patch gemini-cli, write wrapper shim.
# Re-running is safe (rsync + idempotent patch stamp).
set -euo pipefail

GEMINI_CLI_VERSION="0.42.0"
HOMEBREW_SRC="/opt/homebrew/Cellar/gemini-cli/${GEMINI_CLI_VERSION}/libexec/lib/node_modules/@google/gemini-cli"
VENDOR_DIR="${HOME}/.penumbra/vendor/gemini-antigravity"
BIN_DIR="${HOME}/.penumbra/bin"
AG_HOME="${HOME}/.penumbra/home-antigravity"
SECRETS="${HOME}/.penumbra/secrets.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$HOMEBREW_SRC" ]]; then
  echo "ERROR: Homebrew gemini-cli $GEMINI_CLI_VERSION not found at $HOMEBREW_SRC" >&2
  echo "Install with: brew install gemini-cli" >&2
  exit 1
fi

# Load secrets
if [[ -f "$SECRETS" ]]; then
  set -a; source "$SECRETS"; set +a
fi

: "${ANTIGRAVITY_OAUTH_CLIENT_ID:?Set ANTIGRAVITY_OAUTH_CLIENT_ID in $SECRETS}"
: "${ANTIGRAVITY_OAUTH_CLIENT_SECRET:?Set ANTIGRAVITY_OAUTH_CLIENT_SECRET in $SECRETS}"

mkdir -p "$VENDOR_DIR" "$BIN_DIR" "$AG_HOME/.gemini"

# Sync (skip if version matches)
VENDOR_VERSION_FILE="$VENDOR_DIR/.source-version"
if [[ ! -f "$VENDOR_VERSION_FILE" ]] || \
   [[ "$(cat "$VENDOR_VERSION_FILE")" != "$GEMINI_CLI_VERSION" ]]; then
  echo "Syncing gemini-cli $GEMINI_CLI_VERSION to $VENDOR_DIR ..." >&2
  rsync -a --delete "$HOMEBREW_SRC/" "$VENDOR_DIR/"
  printf "%s" "$GEMINI_CLI_VERSION" > "$VENDOR_VERSION_FILE"
fi

# Discover bundle directory (where the chunk-*.js files live)
BUNDLE_DIR=$(find "$VENDOR_DIR" -name "chunk-*.js" -printf "%h\n" 2>/dev/null | \
             sort -u | head -1 || true)

if [[ -z "$BUNDLE_DIR" ]]; then
  # Fallback: any .js under dist/ or build/
  BUNDLE_DIR=$(find "$VENDOR_DIR" \( -path "*/dist/*" -o -path "*/build/*" \) \
               -name "*.js" -printf "%h\n" 2>/dev/null | sort -u | head -1 || true)
fi

if [[ -z "$BUNDLE_DIR" ]]; then
  echo "ERROR: Cannot locate bundle directory under $VENDOR_DIR" >&2
  echo "ERROR: Run Phase 0 spike to identify the correct path." >&2
  exit 1
fi

# Patch (idempotent)
GEMINI_BUNDLE_DIR="$BUNDLE_DIR" \
GEMINI_CLI_VERSION="$GEMINI_CLI_VERSION" \
bash "$SCRIPT_DIR/patch-bundle.sh"

# Discover entry point (bin/gemini.js or similar)
ENTRY=$(find "$VENDOR_DIR/bin" -name "*.js" 2>/dev/null | head -1 || true)
if [[ -z "$ENTRY" ]]; then
  ENTRY=$(find "$VENDOR_DIR" -name "gemini.js" 2>/dev/null | head -1 || true)
fi
if [[ -z "$ENTRY" ]]; then
  echo "ERROR: Cannot find gemini entry point (.js) under $VENDOR_DIR" >&2
  exit 1
fi

# Write shim
SHIM="$BIN_DIR/gemini-antigravity"
cat > "$SHIM" <<SHIM_EOF
#!/usr/bin/env bash
exec env HOME="${AG_HOME}" node "${ENTRY}" "\$@"
SHIM_EOF
chmod +x "$SHIM"

echo "" >&2
echo "Setup complete." >&2
echo "Next: run \`$SHIM auth\` to complete OAuth flow." >&2
echo "Then: bun test scripts/antigravity/agentchat-health.test.ts" >&2
```

### Auth step (manual, requires browser)

```bash
bash scripts/antigravity/setup.sh
~/.penumbra/bin/gemini-antigravity auth
# Complete browser OAuth flow with Antigravity account

# Verify cred isolation
ls ~/.penumbra/home-antigravity/.gemini/   # should show oauth_creds.json
ls ~/.gemini/                              # should NOT show any new files
```

**GREEN check**: `bun test scripts/antigravity/agentchat-health.test.ts` — all 4 tests pass.

---

## Phase 4: agentchat.yaml Wiring — `antigravity-acp-pro`

**Goal**: Register one role, reload daemon, send one message round-trip.

### Failing test (RED)

Before adding the yaml entry, `agent_recommend` for `antigravity-acp-pro` returns nothing.
Document this as the pre-condition baseline; the "test" here is the smoke dispatch below.

### agentchat.yaml entry

```yaml
# --- Antigravity ACP roles (separate Homebrew install, patched bundle) ---
- name: antigravity-acp-pro
  adapter: stdio-acp
  command: /Users/acordeiro/.penumbra/bin/gemini-antigravity
  args: ["--acp"]
  env:
    HOME: /Users/acordeiro/.penumbra/home-antigravity
  caps:
    max_tokens: 65536
    tools: true
    streaming: true
  health_check:
    command: /Users/acordeiro/.penumbra/bin/gemini-antigravity
    args: ["--version"]
    env:
      HOME: /Users/acordeiro/.penumbra/home-antigravity
    timeout_ms: 5000
    expected_exit_code: 0
```

**NOTE**: The HOME env is the ONLY runtime env needed. client_id/secret are baked into the
patched bundle JS at setup time.

### Steps

1. Add entry to `agentchat.yaml`
2. `mcp__penumbra__daemon_reload_config`
3. Smoke dispatch:
   ```
   chain_start(
     initial_agent: "antigravity-acp-pro",
     message: "Reply with the single word: PONG",
     task_class: "TRIVIAL",
     use_worktree: false,
     max_hops: 1,
   )
   ```
4. `chain_wait(conversation_id, timeout_ms: 60000)`
5. `chain_get_response(conversation_id)` — verify response contains "PONG"
6. `dispatch_audit(handoff_id)` — verify `trustworthy: true`

**GREEN when**: dispatch completes with `status: completed`, response contains PONG,
audit shows no `no_worktree_activity` or auth error events.

---

## Phase 5A: Gemini 3.5 Flash Entry

**Prerequisite from Phase 0 spike**: confirm the env var or flag for model selection.
If `GEMINI_MODEL=gemini-2.5-flash` works, use that. If it requires `--model` arg, adjust
`args` in the yaml entry below.

### agentchat.yaml entry

```yaml
- name: antigravity-acp-flash
  adapter: stdio-acp
  command: /Users/acordeiro/.penumbra/bin/gemini-antigravity
  args: ["--acp"]
  env:
    HOME: /Users/acordeiro/.penumbra/home-antigravity
    GEMINI_MODEL: gemini-2.5-flash   # verify env var name during Phase 0 spike
  caps:
    max_tokens: 65536
    tools: true
    streaming: true
```

**Smoke test**: same PONG pattern. Also observe response latency vs `antigravity-acp-pro` —
Flash should be measurably faster.

---

## Phase 5B: Claude 4.6 Entry (Conditional)

**Gate**: During Phase 0 spike, test whether the Antigravity backend accepts a Claude model
identifier (e.g., `GEMINI_MODEL=claude-sonnet-4-6`). The gemini-cli wire protocol is
Gemini-specific; Claude routing requires Antigravity to translate at the proxy layer.

**If Phase 0 confirms Claude routing works**:

```yaml
- name: antigravity-acp-claude-4-6
  adapter: stdio-acp
  command: /Users/acordeiro/.penumbra/bin/gemini-antigravity
  args: ["--acp"]
  env:
    HOME: /Users/acordeiro/.penumbra/home-antigravity
    GEMINI_MODEL: claude-sonnet-4-6   # speculative — verify exact name in Phase 0
  caps:
    max_tokens: 200000
    tools: true
    streaming: true
```

**If Phase 0 shows Claude routing is unavailable**: skip this phase. Document the limitation
and watch `google-antigravity/antigravity-cli#31` (upstream `--acp` flag request on `agy`).

---

## Phase 6: Bench + Fleet Promotion

**Goal**: Replace capacity-exhausted Code Assist dispatches with Antigravity routing for
eligible tasks, once parity is confirmed.

### Bench battery (for each new role)

Run three standard tests in sequence; compare against existing `gemini-acp-pro`:

| Test | Prompt | Pass criterion |
|---|---|---|
| 1-shot implementation | "Add a `clamp(n, min, max)` utility to src/utils/math.ts and export it" | File exists with correct impl; no hallucinated success |
| Multi-turn tool | "Read package.json, extract the `name` field, write it to /tmp/agtest.txt" | File written with correct content |
| Long-context Q&A | Paste a 10k-char file + "Summarize the top 3 architectural decisions" | Coherent answer; no truncation artifact |

Record: success/fail, latency, output quality notes.

### Fleet promotion steps

1. After all three roles pass bench: enable for `task_class: TRIVIAL` dispatches only.
   Use `allow_agents` eligibility in any task that should prefer Antigravity.
2. After 5 successful TRIVIAL dispatches without errors: expand to `STANDARD`.
3. Do **not** remove existing `gemini-acp-pro` entries until Antigravity has 20+ successful
   dispatches with no auth errors, no capacity errors, and quality parity.
4. Update `AGENTS.md`: document new roles, setup prerequisite
   (`bash scripts/antigravity/setup.sh` + manual auth step), and cred renewal path
   (`~/.penumbra/bin/gemini-antigravity auth`).

---

## Failure Modes & Rollback

| Failure | Detection | Remediation |
|---|---|---|
| Bundle layout changed on `brew upgrade gemini-cli` | `patch-bundle.sh` exits non-zero; grep finds nothing | Pin `GEMINI_CLI_VERSION`; do not `brew upgrade` without re-running `setup.sh` |
| Antigravity client_id revoked / rotated | `gemini-antigravity auth` returns `invalid_client` | Update `~/.penumbra/secrets.env` with new creds; delete vendor stamp; re-run `setup.sh` |
| `daily-cloudcode-pa` returns 404 or 500 | ACP `initialize` response contains error; dispatch fails | Remove `antigravity-acp-*` from `agentchat.yaml`; `daemon_reload_config`; fall back to `gemini-acp-pro` |
| HOME isolation broken; creds conflict | `gemini-acp-pro` starts failing with `token_expired` | Verify `HOME` env is set in shim; check `~/.gemini/` is untouched |
| Token expiry; refresh hangs interactively | Dispatch hangs at auth prompt; watchdog kills after 300s | Re-run `gemini-antigravity auth`; may need launchd token-refresh daemon for long-running sessions |
| openab PR #865 technique deprecated | API shape mismatch; `initialize` fails | Upstream watch: if `agy --acp` lands, switch to that and delete patch script |

**Full rollback**: remove `antigravity-acp-*` entries from `agentchat.yaml` +
`daemon_reload_config`. The patched vendor dir at `~/.penumbra/vendor/gemini-antigravity/`
is harmless to leave in place — it does not affect Code Assist.

---

## Trade-offs — What Was Cut and Why

| Cut | Reason |
|-----|--------|
| Per-invocation runtime patching (wrapper that patches a temp copy on each spawn) | Higher latency, race risk, harder rollback. Side-by-side vendor copy is patched once and reused. |
| Pre-spawn `pre_command` hook in `stdio-acp` | Not confirmed available in the adapter (Open Question #6); setup runs once manually instead. Revisit only if Phase 0 surfaces a need. |
| Automated token re-auth daemon | Token-refresh behavior is unknown until Phase 0; manual re-auth via `gemini-antigravity auth` is acceptable for v1. |
| Schema migrations | YAML-only fleet entries; no daemon/core schema changes needed. |
| Reuse of existing `agy-cli` adapter | `agy-cli` is for a different surface (1-shot `agy --print`). The patched gemini bundle speaks ACP natively, so `stdio-acp` is the right adapter and avoids coupling. |
| Claude 4.6 entry (Phase 5B) committed up-front | Gated on Phase 0 confirming the Antigravity backend accepts non-Gemini model IDs. Do not speculate on model routing before the endpoint is verified. |
| Parallel subagent-per-phase execution | Sequential inline execution is faster + cheaper for a 5-phase spike with a hard gate at Phase 0. |
| `MEMORY.md`-style stable identity for patched bundle | Stamp file (`.antigravity-patched-$VERSION`) is sufficient idempotence; full hash-based identity is overkill. |

### Conflict notes (from persona drafts)

- **Phase 1 fixture timing** — synthesizer flagged: "spike first, fixture after Phase 0 records real constants." This plan disagrees: the regex *is* the contract, so synthetic literals matching the regex test the patch correctness without needing the real OAuth values. The fixture in `chunk-synthetic.js` is deliberately synthetic. Phase 0 records the real-bundle path and entry point (which the fixture does not need to know about).
- **Side-by-side vs runtime wrapper** — architect and simplifier converged on side-by-side; risk concurred. No dissent; documented here so the choice doesn't drift mid-implementation.

---

## Open Questions (must resolve during Phase 0)

1. **Exact bundle path in Homebrew 0.42.0**: `dist/bundle/chunk-*.js`? `build/`? `lib/`?
   Determines `BUNDLE_DIR` in `setup.sh` and the fixture for tests.

2. **Actual gemini.js entry point**: `bin/gemini.js`? Root `gemini.js`? The shim needs the
   correct path. Run `find /opt/homebrew/.../gemini-cli -name "gemini.js"` during spike.

3. **Model selection mechanism**: `GEMINI_MODEL` env var? `--model` CLI flag?
   Gemini 2.5 Flash model name: `gemini-2.5-flash`? `gemini-flash-2.5`? Inspect chunk source
   or run `HOME=/tmp/ag-home node /tmp/gemini-ag-test/bin/gemini.js --help`.

4. **Claude 4.6 availability**: does the Antigravity routing layer accept non-Gemini model IDs?
   If yes, what is the accepted model name string?

5. **Token refresh behavior**: does `gemini --acp` with an expired token fail gracefully
   (error response on `initialize`) or block waiting for interactive auth? Affects whether
   the role needs a token-refresh mechanism before it can be reliably used in unattended dispatches.

6. **`stdio-acp` pre-spawn hook**: does `agentchat.yaml` support a `pre_command` field?
   If yes, `setup.sh` could be wired as a pre-spawn check rather than a one-time manual step.
   Check `packages/agentchat/src/adapters/stdio-acp.ts` (or equivalent) before Phase 4.

---

## Estimated Wall Time

```
Phase 0 — OAuth spike (manual, browser wait)          ~1h
Phase 1 — Write failing tests                         ~30m
Phase 2 — patch-bundle.sh implementation              ~45m
Phase 3 — setup.sh + manual auth step                 ~1h
Phase 4 — yaml wiring + daemon reload + smoke         ~30m
Phase 5A — Flash entry + smoke                        ~20m
Phase 5B — Claude 4.6 gate (conditional)             ~20m
Phase 6 — Bench + fleet promotion                     ~1h
────────────────────────────────────────────────────────────
Total                                                 ~5.5h (Phase 0 must succeed first)
```

**Do not proceed past Phase 0 if auth fails.** The entire bridge depends on the OAuth flow
surviving the bundle patch. If it fails, the fallback is to wait for `agy --acp` upstream
support (antigravity-cli#31) or a first-party Antigravity API key.
