import type { Database } from 'bun:sqlite';
import { TaskWriter } from './writer.js';

/**
 * Read-only facade over `TaskWriter`. Lets callers (HTTP routes, MCP tools,
 * UI projections) depend on `TaskReader` without pulling in write methods,
 * so an unintended `file()`/`lease()` becomes a type error rather than a
 * silent live-fire.
 */
export class TaskReader {
  readonly get: TaskWriter['get'];
  readonly list: TaskWriter['list'];

  constructor(db: Database) {
    const writer = new TaskWriter(db);
    this.get = writer.get.bind(writer);
    this.list = writer.list.bind(writer);
  }
}
