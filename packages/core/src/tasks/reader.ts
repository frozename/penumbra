import type { Database } from "bun:sqlite";

import type { AgentDescriptor } from "./eligibility.js";

import { TaskWriter } from "./writer.js";

/**
 * Read-only facade over `TaskWriter`. Lets callers (HTTP routes, MCP tools,
 * UI projections) depend on `TaskReader` without pulling in write methods,
 * so an unintended `file()`/`lease()` becomes a type error rather than a
 * silent live-fire.
 */
export class TaskReader {
  readonly get: TaskWriter["get"];
  readonly list: TaskWriter["list"];

  constructor(
    db: Database,
    deps?: {
      now?: () => number;
      resolveAgent?: (name: string) => AgentDescriptor | undefined;
    },
  ) {
    const writer = new TaskWriter(db, deps ?? {});
    this.get = writer.get.bind(writer);
    this.list = writer.list.bind(writer);
  }
}
