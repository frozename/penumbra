# Strict-lint toolchain rollout — phased TDD plan

> Source spec: `docs/superpowers/specs/2026-05-28-strict-lint-toolchain.md`
> Source synthesis: `.penumbra/reviews/2026-05-28T10-47-44.023Z/synthesis.md`
> Plan date: 2026-05-28

## Resolved open decisions

1. **`exactOptionalPropertyTypes` to `tsconfig.base.json`** — Decision: defer to a dedicated migration PR after Phase 4 completes. Lint-only enforcement via `tsconfig.eslint.json` is the wedge; production typecheck adoption requires a separate sweep.
2. **`verbatimModuleSyntax` timing** — Decision: standalone sweep PR BEFORE Phase 3 auto-fix. Auto-fix handles ~95%; the remaining 5% (mixed re-exports) needs manual judgment that doesn't belong in the cosmetic sweep commit.
3. **`no-explicit-any` escalation owner** — Decision: Wave B per-package promotion, no fixed date. Permanent-warn is acceptable for files where `any` is genuinely necessary (e.g. SDK passthrough types); each promotion sweep records remaining counts.
4. **`sonarjs/no-duplicate-string` threshold** — Decision: disable entirely. The rule fires on route paths, SQL column names, and event names that are repetitive by design.
5. **`unused-imports` vs `@typescript-eslint/no-unused-vars`** — Decision: keep `unused-imports/no-unused-imports` only; disable `@typescript-eslint/no-unused-vars`. Avoids duplicate diagnostics on the same symbol.

---

## Phase 0 — Protect build invariants

Dispatch graph: 0.1 → 0.2

### Task 0.1 — Baseline-protection test

```yaml meta
id: "0.1"
files:
  - scripts/tooling/strict-lint-rollout.test.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

**Write the test first** (`scripts/tooling/strict-lint-rollout.test.ts`):

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

describe("strict-lint rollout — baseline invariants", () => {
  it("tsconfig.json keeps the project-references shape", () => {
    const cfg = JSON.parse(readFileSync("tsconfig.json", "utf8"));
    expect(cfg.files).toEqual([]);
    expect(Array.isArray(cfg.references)).toBe(true);
    expect(cfg.references.length).toBeGreaterThan(0);
  });

  it("root typecheck script still drives tsc --build", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.typecheck).toContain("tsc --build");
  });

  it("tsc --build exits 0", () => {
    const r = spawnSync("bun", ["run", "typecheck"], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
```

Runs RED until the pre-existing `routing.ts` error is fixed in 0.2. Commit the test on a feature branch and let it stay red until 0.2 lands.

### Task 0.2 — Fix existing red baseline

```yaml meta
id: "0.2"
files:
  - packages/config/src/files/routing.ts
  - packages/mcp/test/chain-cancel.test.ts
  - packages/mcp/test/tools/registry.test.ts
  - packages/mcp/test/tools/brainstorm.test.ts
file_scope: modify-existing
depends_on: ["0.1"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: substantial
risk_class: schema-aware
```

Fix the 2 pre-existing typecheck errors in `packages/config/src/files/routing.ts` (workload.ts rootDir issue) and the 3 failing test suites in `packages/mcp/test/` (chain-cancel, tools/registry, tools/brainstorm). After this lands, "lint red" is attributable entirely to new rules, not inherited failures.

Verify per failure mode:
- Typecheck: `bun run typecheck` returns 0
- Tests: `bun test packages/mcp/test/chain-cancel.test.ts packages/mcp/test/tools/registry.test.ts packages/mcp/test/tools/brainstorm.test.ts` all pass
- 0.1's RED test now passes

**Integration:** Cherry-pick 0.1 + 0.2 onto main as one commit each. `bun run typecheck && bun test` must be green on main before Phase 1 dispatches.

---

## Phase 1 — Scaffolding (no rules enforced yet)

Dispatch graph: 1.1 → 1.2 ∥ 1.3 ∥ 1.4 → 1.5

### Task 1.1 — Smoke test for lint absence

```yaml meta
id: "1.1"
files:
  - scripts/tooling/lint-scaffolding.test.ts
file_scope: new
depends_on: ["0.2"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

```ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

describe("lint scaffolding", () => {
  it("bun run lint succeeds (config present, dependencies installed)", () => {
    const r = spawnSync("bun", ["run", "lint"], { encoding: "utf8" });
    // exit 0 means lint config loaded and ran; non-zero still means VIOLATIONS,
    // not config breakage. We assert <128 (eslint's "no config" exit code).
    expect(r.status).not.toBe(128);
  });
});
```

RED until 1.2-1.5 land.

### Task 1.2 — Install dependencies

```yaml meta
id: "1.2"
files:
  - package.json
  - bun.lock
file_scope: modify-existing
depends_on: ["1.1"]
parallel_with: ["1.3", "1.4"]
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: schema-aware
```

```sh
bun add -d typescript eslint typescript-eslint @eslint/js globals \
  prettier eslint-config-prettier \
  eslint-plugin-unicorn eslint-plugin-import-x eslint-import-resolver-typescript \
  eslint-plugin-unused-imports eslint-plugin-sonarjs eslint-plugin-perfectionist \
  eslint-plugin-regexp eslint-plugin-security
```

**Compatibility matrix (verify after install):**
- ESLint 9.x
- `typescript-eslint` 8.x
- `eslint-plugin-unicorn` ≥55
- `eslint-plugin-sonarjs` ≥3
- `eslint-plugin-perfectionist` ≥4
- `eslint-plugin-unused-imports` ≥4

If a plugin pins to an older ESLint major, halt and surface the conflict before continuing.

### Task 1.3 — Create `tsconfig.eslint.json`

```yaml meta
id: "1.3"
files:
  - tsconfig.eslint.json
file_scope: new
depends_on: ["1.1"]
parallel_with: ["1.2", "1.4"]
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "eslint.config.mjs", "scripts/**/*.ts"],
  "exclude": ["node_modules", "**/dist", "coverage", ".penumbra"]
}
```

Critical: this file is referenced **only** by ESLint's `parserOptions.project`. It is NEVER passed to `tsc --build`. The strict flags above are lint-only enforcement; production typecheck remains unchanged.

### Task 1.4 — Create `prettier.config.mjs` + `.prettierignore`

```yaml meta
id: "1.4"
files:
  - prettier.config.mjs
  - .prettierignore
file_scope: new
depends_on: ["1.1"]
parallel_with: ["1.2", "1.3"]
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

`prettier.config.mjs`:

```js
export default {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
};
```

`.prettierignore`:

```
node_modules
**/dist
coverage
bun.lock
.penumbra
docs/notes
```

### Task 1.5 — Create `eslint.config.mjs` + add scripts

```yaml meta
id: "1.5"
files:
  - eslint.config.mjs
  - package.json
file_scope: extend-shared
depends_on: ["1.2", "1.3", "1.4"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: substantial
risk_class: bootstrap-touching
```

`eslint.config.mjs` skeleton (no rules enforced yet — placeholder shape only; rules land in Phase 2):

```js
import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "coverage/**", "node_modules/**", "bun.lock", ".penumbra/**", "docs/notes/**"],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["packages/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, Bun: "readonly" },
    },
    rules: {
      // Placeholder — Phase 2 populates the calibrated rule set
    },
  },
  prettierConfig,
);
```

Add to root `package.json` (do NOT modify existing `typecheck`):

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier . --write",
    "format:check": "prettier . --check"
  }
}
```

**Integration:** Land 1.2-1.5 as one squash commit titled `chore: install + scaffold strict-lint toolchain (no rules enforced)`. Verify `bun run lint` returns 0 (no rules, no violations) and `bun run format:check` returns 0 or 1 (any formatting drift is expected but not catastrophic). 1.1's RED test now passes.

---

## Phase 2 — Severity-calibrated rule set

Dispatch graph: 2.1 ∥ 2.2 → 2.3

### Task 2.1 — Baseline-snapshot script

```yaml meta
id: "2.1"
files:
  - scripts/tooling/lint-baseline.ts
  - scripts/tooling/lint-baseline.test.ts
file_scope: new
depends_on: ["1.5"]
parallel_with: ["2.2"]
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

Test:

```ts
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

describe("lint baseline capture", () => {
  it("writes a per-rule violation JSON to docs/quality/", () => {
    spawnSync("bun", ["run", "scripts/tooling/lint-baseline.ts"], { encoding: "utf8" });
    const out = "docs/quality/lint-baseline-2026-05-28.json";
    expect(existsSync(out)).toBe(true);
    const data = JSON.parse(readFileSync(out, "utf8"));
    expect(typeof data.totals.errors).toBe("number");
    expect(typeof data.totals.warnings).toBe("number");
    expect(typeof data.byRule).toBe("object");
  });
});
```

Implementation: run `eslint . --format json` via spawn, aggregate per `ruleId`, write to `docs/quality/lint-baseline-<YYYY-MM-DD>.json` with `{ totals, byRule, byFile }`.

### Task 2.2 — Enable calibrated rule set

```yaml meta
id: "2.2"
files:
  - eslint.config.mjs
file_scope: modify-existing
depends_on: ["1.5"]
parallel_with: ["2.1"]
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: substantial
risk_class: bootstrap-touching
```

Populate the placeholder `rules: { ... }` block. Three tiers:

**Error from day one** (low violation count, high correctness value):

```js
"@typescript-eslint/no-floating-promises": "error",
"@typescript-eslint/no-misused-promises": "error",
"@typescript-eslint/await-thenable": "error",
"@typescript-eslint/return-await": ["error", "always"],
"@typescript-eslint/require-await": "error",
"@typescript-eslint/switch-exhaustiveness-check": "error",
"@typescript-eslint/no-unsafe-assignment": "error",
"@typescript-eslint/no-unsafe-member-access": "error",
"@typescript-eslint/no-unsafe-call": "error",
"@typescript-eslint/no-unsafe-return": "error",
"@typescript-eslint/only-throw-error": "error",
"no-console": ["error", { allow: ["warn", "error"] }],
"no-debugger": "error",
"no-alert": "error",
"eqeqeq": ["error", "always"],
"curly": ["error", "all"],
"prefer-const": "error",
"no-var": "error",
"unused-imports/no-unused-imports": "error",
"@typescript-eslint/no-unused-vars": "off",
"regexp/no-super-linear-backtracking": "error",
"regexp/no-unused-capturing-group": "error",
"regexp/no-useless-flag": "error",
"import-x/no-cycle": "error",
"import-x/no-duplicates": "error",
"import-x/first": "error",
"security/detect-eval-with-expression": "error",
"security/detect-new-buffer": "error",
```

**Warn** (high violation count, escalate after sweep):

```js
"@typescript-eslint/no-explicit-any": "warn",
"@typescript-eslint/explicit-function-return-type": ["warn", { allowExpressions: false, allowTypedFunctionExpressions: true }],
"@typescript-eslint/explicit-module-boundary-types": "warn",
"@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
"@typescript-eslint/no-import-type-side-effects": "warn",
"no-warning-comments": ["warn", { terms: ["todo", "fixme", "hack", "xxx"], location: "anywhere" }],
"perfectionist/sort-imports": ["warn", { type: "natural", order: "asc", newlinesBetween: "always", groups: ["type", ["builtin", "external"], "internal", ["parent", "sibling", "index"], "side-effect", "object", "unknown"] }],
"perfectionist/sort-named-imports": ["warn", { type: "natural", order: "asc" }],
"perfectionist/sort-named-exports": ["warn", { type: "natural", order: "asc" }],
"perfectionist/sort-exports": ["warn", { type: "natural", order: "asc" }],
"max-lines-per-function": ["warn", { max: 150, skipBlankLines: true, skipComments: true }],
"sonarjs/cognitive-complexity": ["warn", 15],
"unicorn/no-for-loop": "warn",
"unicorn/no-array-for-each": "warn",
"unicorn/prefer-node-protocol": "warn",
"unicorn/prefer-string-replace-all": "warn",
"unicorn/prefer-set-has": "warn",
"unicorn/throw-new-error": "warn",
"security/detect-non-literal-fs-filename": "warn",
"security/detect-non-literal-regexp": "warn",
```

**Disabled** (per resolved decisions + synthesis):

```js
"@typescript-eslint/prefer-readonly-parameter-types": "off",
"@typescript-eslint/consistent-type-definitions": "off",
"@typescript-eslint/member-ordering": "off",
"perfectionist/sort-object-types": "off",
"import-x/order": "off",
"complexity": "off",
"sonarjs/no-duplicate-string": "off",
"security/detect-object-injection": "off",
"unicorn/prevent-abbreviations": "off",
"unicorn/no-null": "off",
```

**Per-directory override** for handler-heavy files:

```js
{
  files: ["packages/**/routes/**/*.ts", "packages/**/tools/**/*.ts"],
  rules: {
    "max-lines-per-function": ["warn", { max: 250, skipBlankLines: true, skipComments: true }],
  },
},
```

**Test-file relax** (keep this block from the original spec):

```js
{
  files: ["**/*.test.ts", "**/*.spec.ts"],
  rules: {
    "@typescript-eslint/no-non-null-assertion": "off",
    "max-lines-per-function": "off",
  },
},
```

### Task 2.3 — Capture and commit baseline

```yaml meta
id: "2.3"
files:
  - docs/quality/lint-baseline-2026-05-28.json
file_scope: new
depends_on: ["2.1", "2.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

```sh
bun run scripts/tooling/lint-baseline.ts
git add docs/quality/lint-baseline-2026-05-28.json
```

This file is the checkpoint Phase 4 ratchets against. Future commits MUST NOT increase any per-rule count without a documented reason.

**Integration:** Land 2.1-2.3 as one squash commit titled `feat(lint): enable calibrated strict-lint rule set + baseline capture`. `bun run lint` is now red (expected); `bun run typecheck` remains green.

---

## Phase 3 — Auto-fix sweep (isolated commit)

Dispatch graph: 3.1 → 3.2 → 3.3

### Task 3.1 — `verbatimModuleSyntax` manual sweep (pre-autofix)

```yaml meta
id: "3.1"
files:
  - packages/*/src/**/*.ts
file_scope: modify-existing
depends_on: ["2.3"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: substantial
risk_class: schema-aware
```

The ESLint autofixer handles ~95% of `consistent-type-imports`. The remaining ~5% — re-export files mixing value + type re-exports — needs manual judgment. Run `bun run lint . 2>&1 | grep "consistent-type-imports"` to enumerate; convert ambiguous `export *` chains by hand.

Verify: `bun run typecheck` green after sweep.

### Task 3.2 — Auto-fix + format sweep

```yaml meta
id: "3.2"
files:
  - packages/**/*.ts
file_scope: modify-existing
depends_on: ["3.1"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

```sh
bun run lint:fix
bun run format
```

Land as one commit titled `chore: auto-fix + prettier sweep across all packages`. The diff will be large and cosmetic; isolating it keeps `git blame` usable.

### Task 3.3 — Verify no runtime regression

```yaml meta
id: "3.3"
files:
  - (verification only — no edits)
file_scope: modify-existing
depends_on: ["3.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

```sh
bun test
bun run typecheck
```

Any failure here is a blocker — an autofixer changed runtime behavior. Investigate before continuing.

**Integration:** 3.1 lands first (manual sweep). 3.2 lands as the cosmetic squash. 3.3 is verification, no commit. If 3.3 fails, revert 3.2 and triage.

---

## Phase 4 — Ratchet warn → error in waves

Dispatch graph: 4.1 → 4.2 → 4.3

### Task 4.1 — Wave A: no-console + consistent-type-imports → error

```yaml meta
id: "4.1"
files:
  - eslint.config.mjs
  - docs/quality/lint-baseline-2026-05-28.json
file_scope: modify-existing
depends_on: ["3.3"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: schema-aware
```

Promote in `eslint.config.mjs`:

```js
"no-console": ["error", { allow: ["warn", "error"] }],  // already error — verify
"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
"@typescript-eslint/no-import-type-side-effects": "error",
```

Sweep any remaining `console.log/info/debug` calls (~20 from baseline). Re-run baseline:

```sh
bun run scripts/tooling/lint-baseline.ts
```

The new baseline file replaces `lint-baseline-2026-05-28.json`. Commit the replaced baseline alongside the rule change.

### Task 4.2 — Wave B: `no-explicit-any` → error for `packages/core`

```yaml meta
id: "4.2"
files:
  - eslint.config.mjs
  - packages/core/src/**/*.ts
file_scope: modify-existing
depends_on: ["4.1"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

Add per-package override:

```js
{
  files: ["packages/core/**/*.ts"],
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
  },
},
```

Fix all `any` in `packages/core/` to either a real type, `unknown` + narrowing, or `// eslint-disable-next-line` with a one-line rationale.

Verify: `bun test packages/core/`, `bun run typecheck`, `bun run lint packages/core/`. Then repeat for `packages/api-contract`, `packages/config`, etc. in subsequent commits — one package per commit.

### Task 4.3 — Wave C: tighten thresholds

```yaml meta
id: "4.3"
files:
  - eslint.config.mjs
file_scope: modify-existing
depends_on: ["4.2"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: schema-aware
```

Tighten in `eslint.config.mjs`:

```js
"max-lines-per-function": ["warn", { max: 120, skipBlankLines: true, skipComments: true }],
"sonarjs/cognitive-complexity": ["warn", 12],
```

Keep the `routes/**` + `tools/**` override at `max: 250` for now. Re-capture baseline.

**Integration:** Each wave is one commit. Land sequentially; Wave A first. Title pattern: `chore(lint): ratchet <rule> → error (Wave <N>)`.

---

## Phase 5 — Hook + CI integration

Dispatch graph: 5.1 ∥ 5.2 → 5.3

### Task 5.1 — Pre-commit hook (prettier only, fast)

```yaml meta
id: "5.1"
files:
  - .husky/pre-commit
  - package.json
file_scope: new
depends_on: ["4.3"]
parallel_with: ["5.2"]
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: bootstrap-touching
```

Install `lint-staged` if not present (`bun add -d lint-staged`). Config in `package.json`:

```json
{
  "lint-staged": {
    "*.{ts,mjs,json,md}": "prettier --check"
  }
}
```

`.husky/pre-commit`:

```sh
#!/usr/bin/env sh
bunx lint-staged
```

Target latency: ~2s. Do NOT include `bun run lint` or `bun run typecheck` in pre-commit.

### Task 5.2 — Pre-push hook (`bun run lint`)

```yaml meta
id: "5.2"
files:
  - .husky/pre-push
file_scope: new
depends_on: ["4.3"]
parallel_with: ["5.1"]
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: bootstrap-touching
```

`.husky/pre-push`:

```sh
#!/usr/bin/env sh
bun run lint
```

Target latency: ~15s. Blocks the push if any error-tier rule is violated.

### Task 5.3 — CI gate

```yaml meta
id: "5.3"
files:
  - .github/workflows/check.yml
file_scope: new
depends_on: ["5.1", "5.2"]
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: codex-acp-spark
task_size: small
risk_class: bootstrap-touching
```

Add a `check` job to CI that runs:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
```

Target latency: ~60s. Blocks merge on red.

**Integration:** Land 5.1-5.3 as one squash commit titled `chore(ci): enforce strict-lint via pre-commit/pre-push/CI gates`. Dry-run a commit with a staged lint violation to confirm pre-commit passes (it only runs prettier) and pre-push blocks.

---

## Trade-offs (carried from synthesis)

| Decision | Upside | Cost |
|---|---|---|
| `tsconfig.eslint.json` separate from build | Build pipeline untouched; lint can use stricter flags safely | Two tsconfig files to keep in sync for extends chain |
| Most rules start at `warn` | CI stays green on day one; developers see signal without being blocked | Warn noise is easy to ignore; requires deliberate escalation discipline |
| Drop `complexity`, keep cognitive-complexity | Eliminates redundant double-counting | Loss of one data point; cognitive-complexity is strictly more informative |
| Disable `prefer-readonly-parameter-types` | Eliminates lint penalty + false positives | Loses a theoretical safety check with near-zero real findings here |
| Pre-push (not pre-commit) for lint | Commit path stays fast | Violations discovered slightly later; acceptable with PR review gate |

## Out of scope

- `exactOptionalPropertyTypes` to `tsconfig.base.json` (separate migration PR after Phase 4)
- `verbatimModuleSyntax` to `tsconfig.base.json` (same — lint-only enforcement via `tsconfig.eslint.json` is the wedge)
- Documenting `eslint-disable` rationales (deferred — promote the rule first, then sweep disables)
- Migrating `@typescript-eslint/no-explicit-any` to error for every package (Phase 4 Wave B handles `packages/core` only; remaining packages are a long tail)
