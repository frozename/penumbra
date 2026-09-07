import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import importX from "eslint-plugin-import-x";
import perfectionist from "eslint-plugin-perfectionist";
import regexp from "eslint-plugin-regexp";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

// Keep these CONGRUENT with the type-aware parser projects' `include` globs:
// eslint must lint exactly the files those projects cover. A file linted but
// outside the projects parses without type info and falls back to base JS
// rules (no-undef, base no-unused-vars) plus emits a parse error — the source
// of thousands of spurious findings.
const SOURCE_GLOBS = [
  "packages/**/src/**/*.ts",
  "packages/**/test/**/*.ts",
  "packages/**/bin/**/*.ts",
  "packages/**/scripts/**/*.ts",
  "packages/console/src/**/*.tsx",
  "packages/console/test/**/*.tsx",
  "packages/console/.storybook/**/*.tsx",
  "plugin/**/*.ts",
  "scripts/**/*.ts",
];

// Burn-down list: files already over the max-lines cap when the rule landed.
// Shrink this list as files are refactored; never add to it.
const LEGACY_LARGE_FILES = [
  "packages/agentchat/bin/agentchat-worker.ts",
  "packages/agentchat/src/adapters/stdio-acp.ts",
  "packages/agentchat/src/penumbra-client.ts",
  "packages/agentchat/src/worker/dispatcher.ts",
  "packages/agentchat/src/worker/merge-reconciler.ts",
  "packages/cli/bin/penumbra.ts",
  "packages/cli/src/commands/config-sync-providers.ts",
  "packages/config/src/env.ts",
  "packages/core/src/db/schema.ts",
  "packages/core/src/services/agent-routing.ts",
  "packages/core/src/tasks/writer.ts",
  "packages/core/src/worktree/manager.ts",
  "packages/core/src/writers/t2.ts",
  "packages/daemon/src/dreaming/cycle.ts",
  "packages/daemon/src/routes/chains.ts",
  "packages/daemon/src/routes/dispatch-land.ts",
  "packages/daemon/src/routes/handoffs.ts",
  "packages/daemon/src/routes/workflows.ts",
  "packages/daemon/src/serve.ts",
  "packages/daemon/src/sweepers/gh-task-sync.ts",
  "packages/mcp/src/daemon-client.ts",
  "packages/mcp/src/tools/registry.ts",
  "plugin/workflows/adversarial-review/workflow.ts",
];

// Burn-down list — may only shrink. .tsx files over the max-lines cap (700)
// when the .tsx globs were turned on. An override block turns max-lines and
// max-lines-per-function off for exactly these files.
export const LEGACY_TSX_FILES = [];

// Burn-down list — may only shrink. Non-autofixable rules residual after
// `eslint --fix` on the console's .tsx files. Applied to packages/console/**/*.tsx.
export const LEGACY_TSX_RULES = {
  "@typescript-eslint/explicit-module-boundary-types": "off",
  "@typescript-eslint/explicit-function-return-type": "off",
  "@typescript-eslint/no-deprecated": "off",
  "@typescript-eslint/no-unnecessary-condition": "off",
  "@typescript-eslint/restrict-template-expressions": "off",
  "@typescript-eslint/no-misused-promises": "off",
  "no-warning-comments": "off",
  "sonarjs/cognitive-complexity": "off",
  "@typescript-eslint/no-empty-function": "off",
  "@typescript-eslint/require-await": "off",
  "@typescript-eslint/prefer-nullish-coalescing": "off",
  eqeqeq: "off",
  "@typescript-eslint/unbound-method": "off",
  "@typescript-eslint/no-unsafe-assignment": "off",
  "@typescript-eslint/no-unsafe-argument": "off",
  "@typescript-eslint/no-unsafe-member-access": "off",
  "@typescript-eslint/no-redundant-type-constituents": "off",
  "@typescript-eslint/no-non-null-assertion": "off",
  "@typescript-eslint/no-explicit-any": "off",
  "no-restricted-imports": "off",
  "@typescript-eslint/no-floating-promises": "off",
  "@typescript-eslint/no-base-to-string": "off",
  "@typescript-eslint/no-unnecessary-type-assertion": "off",
  "@typescript-eslint/non-nullable-type-assertion-style": "off",
};

const LEGACY_LONG_FUNCTION_FILES = [
  "plugin/workflows/adversarial-plan/workflow.ts",
  "plugin/workflows/adversarial-review/workflow.ts",
];

const LEGACY_COMPLEX_FILES = [
  "plugin/workflows/_shared/pool-resolver.ts",
  "plugin/workflows/adversarial-plan/workflow.ts",
  "plugin/workflows/adversarial-review/workflow.ts",
  "plugin/workflows/session-handoff-draft/workflow.ts",
  "plugin/workflows/session-memory-sweep/workflow.ts",
];

const LEGACY_PLUGIN_SOURCE_LINT_FILES = [
  "plugin/skills/systematic-debugging/condition-based-waiting-example.ts",
  "plugin/workflows/_shared/io.ts",
  "plugin/workflows/adversarial-plan/workflow.ts",
  "plugin/workflows/adversarial-review/workflow.ts",
  "plugin/workflows/dispatch-drift-guard/workflow.ts",
  "plugin/workflows/memory-digest/workflow.ts",
  "plugin/workflows/session-handoff-draft/workflow.ts",
  "plugin/workflows/session-memory-sweep/workflow.ts",
];

const DEEP_RELATIVE_IMPORT_EXCEPTIONS = [
  "packages/agentchat/test/integration/reliability-smoke.test.ts",
  "packages/agentchat/test/scripts/acp-promotion/evaluate.test.ts",
  "packages/agentchat/test/scripts/acp-promotion/report.test.ts",
  "packages/agentchat/test/scripts/acp-promotion/run.test.ts",
  "packages/agentchat/test/scripts/acp-promotion/scenarios.test.ts",
  "packages/config/test/commands/config-sync-providers.test.ts",
  "packages/config/test/files/schemas.test.ts",
  "packages/core/test/tasks/requires-tools-constraint.test.ts",
  "packages/daemon/test/routes/otlp.test.ts",
  "packages/e2e/test/task-board.test.ts",
  "packages/mcp/test/e2e.test.ts",
  "packages/workflows/test/integration/dispatch-drift-guard.test.ts",
  "packages/workflows/test/integration/memory-digest-volatility.test.ts",
  "packages/workflows/test/workflows/adversarial-plan.test.ts",
  "packages/workflows/test/workflows/adversarial-review.test.ts",
];

export default tseslint.config(
  {
    // Global ignores MUST be the SOLE key in this object, or eslint treats them
    // as config-scoped (not global) and built dist/ artifacts, generated .d.ts,
    // and .claude workflow JS leak into the lint as parse errors.
    ignores: [
      "**/dist/**",
      "**/*.d.ts",
      "**/*.spec.ts",
      "**/storybook-static/**",
      "packages/console/visual/**",
      "coverage/**",
      "node_modules/**",
      "bun.lock",
      ".penumbra/**",
      ".claude/**",
      "docs/notes/**",
      "eslint.config.mjs",
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  { ...js.configs.recommended, files: SOURCE_GLOBS },
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: SOURCE_GLOBS,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: SOURCE_GLOBS,
  })),
  {
    files: SOURCE_GLOBS,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: [
          "./packages/*/tsconfig.eslint.json",
          "./packages/integrations/*/tsconfig.eslint.json",
          "./plugin/tsconfig.eslint.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, Bun: "readonly" },
    },
    rules: {
      // Placeholder - Phase 2 populates the calibrated rule set
    },
  },
  {
    files: ["scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
      },
    },
  },
  {
    files: SOURCE_GLOBS,
    plugins: {
      unicorn,
      "import-x": importX,
      "unused-imports": unusedImports,
      sonarjs,
      perfectionist,
      regexp,
      security,
    },
    rules: {
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
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
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
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["../../*"],
              message:
                "Use @src/* (same package) or @penumbra/* (cross-package) instead of deep relative imports.",
            },
          ],
        },
      ],
      "security/detect-eval-with-expression": "error",
      "security/detect-new-buffer": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          allowExpressions: false,
          allowTypedFunctionExpressions: true,
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "warn",
      // Deferred: requires verbatimModuleSyntax in tsconfig.base.json (plan Open Decision #1).
      // Re-enable after the verbatim migration PR; current state has accumulated value/type import drift.
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/no-import-type-side-effects": "off",
      "no-warning-comments": [
        "warn",
        { terms: ["todo", "fixme", "hack", "xxx"], location: "anywhere" },
      ],
      "perfectionist/sort-imports": [
        "warn",
        {
          type: "natural",
          order: "asc",
          internalPattern: ["^@src/"],
          newlinesBetween: 1,
          groups: [
            "type-import",
            ["value-builtin", "value-external"],
            ["type-internal", "value-internal"],
            ["type-parent", "type-sibling", "type-index"],
            ["value-parent", "value-sibling", "value-index"],
            "ts-equals-import",
            "unknown",
          ],
        },
      ],
      "perfectionist/sort-named-imports": ["warn", { type: "natural", order: "asc" }],
      "perfectionist/sort-named-exports": ["warn", { type: "natural", order: "asc" }],
      "perfectionist/sort-exports": ["warn", { type: "natural", order: "asc" }],
      "max-lines": ["warn", { max: 700, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 120, skipBlankLines: true, skipComments: true }],
      "sonarjs/cognitive-complexity": ["warn", 12],
      "unicorn/no-for-loop": "warn",
      "unicorn/no-array-for-each": "warn",
      "unicorn/prefer-node-protocol": "warn",
      "unicorn/prefer-string-replace-all": "warn",
      "unicorn/prefer-set-has": "warn",
      "unicorn/throw-new-error": "warn",
      // Threat-model carve-out (documented, deliberate — NOT a per-call escape):
      // these heuristics flag fs/RegExp built from non-literal values to catch
      // injection from UNTRUSTED input. penumbra is an internal daemon whose
      // paths and patterns are internally constructed (config/worktree/temp/
      // session dirs, internal regexes), never user-supplied, so the rules are
      // pure false-positives here and "fixing" them means hidden indirection,
      // not real safety. Disabled at config level (visible + reviewable) rather
      // than dodged per-call. (nova/llamactl keep these unenforced too.)
      // Re-enable with a real validating boundary if untrusted paths ever reach fs.
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-non-literal-regexp": "off",
      "@typescript-eslint/prefer-readonly-parameter-types": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/member-ordering": "off",
      "perfectionist/sort-object-types": "off",
      "import-x/order": "off",
      complexity: "off",
      "sonarjs/no-duplicate-string": "off",
      "security/detect-object-injection": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-null": "off",
    },
  },
  {
    files: ["packages/**/routes/**/*.ts", "packages/**/tools/**/*.ts"],
    rules: {
      "max-lines-per-function": ["warn", { max: 250, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "max-lines": "off",
      "max-lines-per-function": "off",
    },
  },
  {
    files: LEGACY_LARGE_FILES,
    rules: {
      "max-lines": "off",
    },
  },
  {
    files: LEGACY_LONG_FUNCTION_FILES,
    rules: {
      "max-lines-per-function": "off",
    },
  },
  {
    files: LEGACY_COMPLEX_FILES,
    rules: {
      "sonarjs/cognitive-complexity": "off",
    },
  },
  {
    files: ["plugin/**/*.test.ts"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-conversion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "no-empty": "off",
    },
  },
  {
    files: LEGACY_PLUGIN_SOURCE_LINT_FILES,
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "no-control-regex": "off",
      "no-empty": "off",
      "no-irregular-whitespace": "off",
      "no-useless-escape": "off",
      "regexp/no-super-linear-backtracking": "off",
      "regexp/no-unused-capturing-group": "off",
    },
  },
  {
    files: DEEP_RELATIVE_IMPORT_EXCEPTIONS,
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["packages/console/**/*.tsx"],
    rules: {
      "max-lines-per-function": "off",
      ...LEGACY_TSX_RULES,
    },
  },
  ...(LEGACY_TSX_FILES.length > 0
    ? [
        {
          files: LEGACY_TSX_FILES,
          rules: {
            "max-lines": "off",
            "max-lines-per-function": "off",
          },
        },
      ]
    : []),
  prettierConfig,
);
