import type { WriteToolsExecutor } from './write-tools-executor.js';

const registry = new Map<string, WriteToolsExecutor>();

export function registerExecutor(dispatchId: string, exec: WriteToolsExecutor): void {
  registry.set(dispatchId, exec);
}

export function unregisterExecutor(dispatchId: string): void {
  registry.delete(dispatchId);
}

export function lookupExecutor(dispatchId: string): WriteToolsExecutor | null {
  return registry.get(dispatchId) ?? null;
}

/** Test-only helper to clear the registry between tests. */
export function __resetExecutorRegistry(): void {
  registry.clear();
}
