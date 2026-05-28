# Strict ESLint + Prettier + TypeScript toolchain — proposal

**Date:** 2026-05-28
**Status:** spec / adversarial-plan review target
**Author:** user proposal + maestro context-grounding

## Goal

Enforce a stricter coding standard across penumbra via TypeScript compiler flags, ESLint (with typescript-eslint, unicorn, sonarjs, perfectionist, regexp, security, import-x, unused-imports), and Prettier. The intent is to make AI-coded changes harder to ship loose: explicit return types, smaller functions, deterministic imports/exports, lower complexity, no `any` shortcuts.

## Current state (verified)

- **Monorepo with TS project references.** Root `tsconfig.json` is a build root (`files: []`, `references: [...]` to 8 packages). Per-package `packages/*/tsconfig.json` extends `tsconfig.base.json`. `bun scripts/check-dist-freshness.ts && tsc --build` is the typecheck command.
- **`tsconfig.base.json` already enables:** `strict: true`, `noUncheckedIndexedAccess: true`, `isolatedModules: true`, `esModuleInterop: true`, `skipLibCheck: true`.
- **No existing eslint configuration.** No `.eslintrc*`, no `eslint.config.*`, no `prettier.config.*`. Zero rules enforced today.
- **Estimated violations on existing code (rough greps from `packages/*/src`):**
  - 532 `any` / `@ts-ignore` / `@ts-expect-error` / `!` patterns
  - 84 non-null assertions (`x!.y` style)
  - 20 `console.log` / `console.info` / `console.debug` (the allowed `warn` / `error` are uncounted)
  - Sort-order rules (import sort, named-import sort, union/object-type sort) would touch nearly every file
  - `max-lines-per-function: 80` would flag most tool handlers and route handlers — `packages/mcp/src/tools/registry.ts` alone is 1318 lines
  - `complexity: 8` + `sonarjs/cognitive-complexity: 12` would flag many of the existing routes
  - `prefer-readonly-parameter-types` (proposed at warn) would flag near-everything

## Proposed configuration (user-supplied verbatim)

### Dependencies

```
bun add -d typescript eslint typescript-eslint @eslint/js globals prettier eslint-config-prettier eslint-plugin-unicorn eslint-plugin-import-x eslint-plugin-unused-imports eslint-plugin-sonarjs eslint-plugin-perfectionist eslint-plugin-regexp eslint-plugin-security
```

### `tsconfig.json` (proposed)

Note: this proposal wholesale-replaces the current project-reference root. For monorepo fit it needs adaptation; verbatim shown for review.

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["bun"],
    "strict": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noImplicitThis": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noPropertyAccessFromIndexSignature": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "allowJs": false,
    "checkJs": false,
    "skipLibCheck": false,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "eslint.config.mjs"],
  "exclude": ["node_modules", "dist", "coverage"]
}
```

### `eslint.config.mjs` (proposed)

Full ESLint flat config using `tseslint.configs.strictTypeChecked` + `stylisticTypeChecked`. Plugins: unicorn, import-x, unused-imports, sonarjs, perfectionist, regexp, security. Rules include:

- `no-console: error` (allow warn/error)
- `complexity: ["error", 8]`, `max-depth: 3`, `max-lines-per-function: 80`, `max-params: 4`
- `no-warning-comments: error` for `todo`/`fixme`/`hack`/`xxx`
- `no-restricted-syntax` bans on TSEnumDeclaration, TSNonNullExpression, ForInStatement, WithStatement
- `@typescript-eslint/no-explicit-any: error`
- `@typescript-eslint/no-unsafe-{assignment,member-access,call,return}: error`
- `@typescript-eslint/no-floating-promises: error`
- `@typescript-eslint/explicit-function-return-type: error` (allowTypedFunctionExpressions only)
- `@typescript-eslint/explicit-module-boundary-types: error`
- `@typescript-eslint/prefer-readonly-parameter-types: warn`
- `@typescript-eslint/return-await: ["error", "always"]`
- `@typescript-eslint/consistent-type-imports` with `inline-type-imports` fix style
- `@typescript-eslint/consistent-type-definitions: ["error", "type"]` (no interface)
- `@typescript-eslint/member-ordering: error`
- `@typescript-eslint/naming-convention` strict regime (camelCase default, PascalCase type-like, etc.)
- `sonarjs/cognitive-complexity: 12`, `no-duplicate-string: 5`
- Many `unicorn/*` rules including `filename-case: kebabCase|pascalCase`, `prefer-{includes,spread,ternary,switch}`, `no-array-for-each`, `no-for-loop`
- `perfectionist/sort-{imports,exports,named-imports,named-exports,object-types,union-types}: error`
- `security/detect-eval-with-expression`, `detect-new-buffer`, `detect-non-literal-{fs-filename,regexp}: warn`

Test files relax `no-non-null-assertion`, `prefer-readonly-parameter-types`, `max-lines-per-function`.

### `prettier.config.mjs` (proposed)

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
  endOfLine: "lf"
};
```

### `package.json` scripts (proposed)

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier . --write",
    "format:check": "prettier . --check",
    "check": "bun run typecheck && bun run lint && bun run format:check"
  }
}
```

## Open questions for review

1. **`tsconfig.json` wholesale replacement** vs **merge new flags into `tsconfig.base.json`**. The proposed config is a single-package shape; penumbra is a project-references monorepo. Wholesale replacement would break `tsc --build`.
2. **`verbatimModuleSyntax: true`** requires every type-only import to be explicit. Combined with `consistent-type-imports` auto-fix, this is a massive sweep across all packages on first lint:fix. Is the disruption worth it?
3. **`exactOptionalPropertyTypes: true`** changes semantics around `{ foo?: string }` vs `{ foo: string | undefined }`. Likely surfaces many "real" bugs but also many cosmetic refactors.
4. **`max-lines-per-function: 80`** is aggressive for handler-heavy code. `packages/daemon/src/routes/workflows.ts:workflowsRunRoute` is ~120 lines of straight-line logic. Should handler files be exempted, or should we accept the refactor cost?
5. **`@typescript-eslint/consistent-type-definitions: ["error", "type"]`** bans `interface`. Penumbra uses `interface` for the contract surfaces (e.g. `InvocationSink`, `RegisterFederatedToolsResult`). Auto-fix is safe but rewrites every interface. Worth it?
6. **`@typescript-eslint/member-ordering`** at default settings is opinionated about field order in classes/types. Penumbra is mostly functions but has a few classes (e.g. `DaemonClient`). Disruption is low but rule choice should be deliberate.
7. **`perfectionist/sort-object-types`** sorts object type properties alphabetically. For ergonomic types (e.g. positional database row shapes), alphabetical may hurt readability. Should we opt out for specific files?
8. **`no-warning-comments: error` for `todo`/`fixme`/`hack`/`xxx`** — penumbra's source already contains some TODO comments. They become hard errors on first lint. Should the rule be `warn`, or should we sweep first?
9. **`complexity: 8` + `sonarjs/cognitive-complexity: 12`** thresholds combined would flag many existing routes. Are these the right thresholds for this codebase, or too aggressive?
10. **`prefer-readonly-parameter-types: warn`** is noisy on practical code — most functions don't deep-freeze inputs. Is the warn-level noise actually useful, or pure noise?
11. **Pre-commit hook strategy.** No existing pre-commit hook config visible. Should `bun run check` run on pre-commit (slow), pre-push (cheaper), or as CI-only with no local block?
12. **Plugin freshness.** `eslint-plugin-perfectionist` and `eslint-plugin-import-x` are active forks of older plugins. Are the chosen versions compatible with `typescript-eslint` v8 (which is what `strictTypeChecked` exports today)?
13. **Initial-commit strictness vs gradual.** User has stated preference for adversarial review before commitment. After review, two paths:
    - All rules `error` from day one; `bun run lint` is red until existing code is fixed.
    - Most strict rules at `warn`, escalate to `error` per-rule as code is cleaned.

## Constraints

- Monorepo with 8+ packages under `packages/`.
- Must not break the existing `tsc --build` workflow.
- Must integrate with existing pre-commit hooks if any.
- No introducing test-suite regressions; pre-existing failures in `packages/mcp/test/` (chain-cancel, registry, brainstorm) and pre-existing typecheck errors in `packages/config/src/files/routing.ts` are noted.

## Success criteria for the proposal

- Configuration files committed and runnable (`bun run check` invokes typecheck, lint, format:check).
- A documented baseline: count of violations per rule on first run, captured as a checkpoint for future cleanup work.
- A clear path from "lint red" to "lint green" — either a phased plan to fix existing code, or a per-rule opt-in/disable list with rationale.
