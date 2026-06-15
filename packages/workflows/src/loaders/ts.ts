import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { WorkflowSpecSchema, type WorkflowSpec } from "../schema.js";
import type { WorkflowFn } from "../exec.js";
import type { ZodTypeAny } from "zod";

export type LoadedTsWorkflow = {
  spec: WorkflowSpec;
  fn?: WorkflowFn;
  inputSchema?: ZodTypeAny;
};

// Bun caches ESM imports by resolved filesystem path; query-string and
// symlink tricks do not bust the cache. To pick up workflow.ts edits on
// daemon_reload_config, bundle each load into a fresh temp dir — relative
// imports get inlined, package + node:* imports stay external so identity
// matches the host process (zod schemas remain instanceof-comparable). The
// temp dir is removed after import; the loaded module stays in memory.
//
// The temp dir lives ALONGSIDE the source workflow.ts (not in the OS tmpdir),
// so the externalized `import "zod"` / `@penumbra/*` resolve against the same
// node_modules ancestry the source file itself sees. Emitting into the OS
// tmpdir put the bundle outside any node_modules tree, so zod failed to
// resolve at import time (the temp path canonicalizes through /private/var,
// diverging from any tmpdir-rooted node_modules symlink).
const EXTERNAL = ["zod", "@penumbra/*", "node:*"];

export async function loadTsWorkflow(path: string): Promise<LoadedTsWorkflow> {
  const outDir = mkdtempSync(join(dirname(path), ".penumbra-workflow-"));
  let mod: Record<string, unknown>;
  try {
    const build = await Bun.build({
      entrypoints: [path],
      outdir: outDir,
      format: "esm",
      target: "bun",
      external: EXTERNAL,
    });
    if (!build.success) {
      const reason = build.logs.map((log) => String(log)).join("\n");
      throw new Error(`workflow ${path}: build failed\n${reason}`);
    }
    const builtPath = build.outputs[0]?.path;
    if (!builtPath) {
      throw new Error(`workflow ${path}: build produced no outputs`);
    }
    mod = await import(builtPath);
  } finally {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  const rawSpec = mod.default;
  if (!rawSpec || typeof rawSpec !== "object") {
    throw new Error(`workflow ${path}: missing default export`);
  }
  const spec = WorkflowSpecSchema.parse(rawSpec);
  const fn = (mod.fn ?? mod.run ?? undefined) as LoadedTsWorkflow["fn"];
  const inputSchema = mod.inputSchema as LoadedTsWorkflow["inputSchema"];
  if (inputSchema !== undefined && typeof inputSchema?.parse !== "function") {
    throw new Error(`workflow ${path}: \`inputSchema\` must be a zod schema`);
  }
  if (spec.run.kind === "ts-function" && !fn) {
    throw new Error(`workflow ${path}: ts-function run requires exported \`fn\` (or \`run\`)`);
  }
  return { spec, fn, inputSchema };
}
