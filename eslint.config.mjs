import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "coverage/**",
      "node_modules/**",
      "bun.lock",
      ".penumbra/**",
      "docs/notes/**",
      "eslint.config.mjs",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ["packages/**/*.ts", "scripts/**/*.ts"],
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: ["packages/**/*.ts", "scripts/**/*.ts"],
  })),
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
      // Placeholder - Phase 2 populates the calibrated rule set
    },
  },
  prettierConfig,
);
