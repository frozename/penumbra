import {
  defaultProjectRegistryPath,
  loadProjectRegistry,
  loadProjectRegistryAsync,
  type ProjectRegistry,
} from "@penumbra/core";

import type { ProjectRegistryLike } from "./project-cwd.js";

export type RegistryReloadResult = { ok: true; count: number } | { ok: false; reason: string };

function workerProjectRegistryPath(): string {
  return process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath();
}

function defaultWarn(message: string): void {
  console.warn(message);
}

// Live holder: consumers resolve through get() per dispatch so a reload() swap
// reaches every consumer without a worker restart. A failed reload leaves the
// previous registry in place (the assignment never completes).
export class WorkerProjectRegistry implements ProjectRegistryLike {
  private registry: ProjectRegistry;
  private readonly path?: string;
  private readonly warn: (message: string) => void;

  constructor(path?: string, warn: (message: string) => void = defaultWarn) {
    this.path = path;
    this.warn = warn;
    this.registry = loadProjectRegistry(path ?? workerProjectRegistryPath());
  }

  get size(): number {
    return this.registry.size;
  }

  private registryPath(): string {
    return this.path ?? workerProjectRegistryPath();
  }

  // Async so the control listener isn't blocked by readFile + realpath. A
  // reload that can't produce a usable view of the file — missing/unreadable,
  // unparseable, or a zero-entry result replacing a non-empty registry — is a
  // failure: keep serving the previous registry and report the reason.
  async reload(): Promise<RegistryReloadResult> {
    const path = this.registryPath();
    let next: ProjectRegistry;
    try {
      next = await loadProjectRegistryAsync(path);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.warn(`project registry reload failed: ${reason}`);
      return { ok: false, reason };
    }
    if (next.size === 0 && this.registry.size > 0) {
      const reason = `reloaded to zero entries; keeping previous ${String(this.registry.size)}-entry registry`;
      this.warn(`project registry reload failed: ${reason}`);
      return { ok: false, reason };
    }
    this.registry = next;
    return { ok: true, count: next.size };
  }

  get(project_id: string): ReturnType<ProjectRegistry["get"]> {
    return this.registry.get(project_id);
  }
}
