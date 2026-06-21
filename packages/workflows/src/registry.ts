import type {
  BuildRegistryOpts,
  RegistryEntry as CoreRegistryEntry,
  RegistryError,
  WorkflowRegistry,
} from "@penumbra/core";

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Trigger, WorkflowSpec } from "./schema.js";

import { loadMarkdownPlaybook } from "./loaders/markdown.js";
import { loadTsWorkflow } from "./loaders/ts.js";

export type RegistryEntry<Spec = WorkflowSpec> = CoreRegistryEntry<Spec> & {
  inputSchema?: unknown;
};

export type Registry = Omit<WorkflowRegistry<WorkflowSpec, Trigger>, "entries" | "getEntry"> & {
  entries(): RegistryEntry[];
  getEntry(name: string): RegistryEntry | undefined;
};

export type { BuildRegistryOpts, RegistryError } from "@penumbra/core";

function loadPlaybooks(
  playbooksDir: string,
  entries: RegistryEntry[],
  errors: RegistryError[],
): void {
  if (!existsSync(playbooksDir)) return;
  for (const name of readdirSync(playbooksDir)) {
    const dir = join(playbooksDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const path = join(dir, "playbook.md");
    if (!existsSync(path)) continue;
    try {
      const spec = loadMarkdownPlaybook(path);
      entries.push({ spec, source: "markdown", path });
    } catch (err: unknown) {
      errors.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function loadTsWorkflows(
  workflowsDir: string,
  entries: RegistryEntry[],
  errors: RegistryError[],
): Promise<void> {
  if (!existsSync(workflowsDir)) return;
  for (const name of readdirSync(workflowsDir)) {
    const dir = join(workflowsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const path = join(dir, "workflow.ts");
    if (!existsSync(path)) continue;
    try {
      const { spec, fn, inputSchema } = await loadTsWorkflow(path);
      entries.push({
        spec,
        source: "ts",
        path,
        fn: fn as CoreRegistryEntry<WorkflowSpec>["fn"],
        inputSchema,
      });
    } catch (err: unknown) {
      errors.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export async function buildRegistry(opts: BuildRegistryOpts): Promise<Registry> {
  const { playbooksDir, workflowsDir } = opts;
  const entries: RegistryEntry[] = [];
  const errors: RegistryError[] = [];

  loadPlaybooks(playbooksDir, entries, errors);
  await loadTsWorkflows(workflowsDir, entries, errors);

  const byName = new Map<string, RegistryEntry>();
  for (const e of entries) {
    if (byName.has(e.spec.name)) {
      errors.push({ path: e.path, error: `duplicate workflow name: ${e.spec.name}` });
      continue;
    }
    byName.set(e.spec.name, e);
  }

  const registry: Registry = {
    list: () => [...byName.values()].map((e) => e.spec),
    entries: () => [...byName.values()],
    get: (name) => byName.get(name)?.spec,
    getEntry: (name) => byName.get(name),
    findByTrigger: (event) => {
      const out: WorkflowSpec[] = [];
      for (const entry of byName.values()) {
        for (const t of entry.spec.triggers) {
          if (matchesTrigger(t, event)) {
            out.push(entry.spec);
            break;
          }
        }
      }
      return out;
    },
    errors,
  };
  return registry;
}

function matchesTrigger(t: Trigger, event: Trigger): boolean {
  if (t.kind !== event.kind) return false;
  if (t.kind === "slash" && event.kind === "slash") return t.command === event.command;
  if (t.kind === "lifecycle" && event.kind === "lifecycle") return t.event === event.event;
  if (t.kind === "state-threshold" && event.kind === "state-threshold")
    return t.metric === event.metric && t.op === event.op && t.value === event.value;
  if (t.kind === "manual") return true;
  return false;
}
