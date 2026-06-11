import type { Database, Statement } from "bun:sqlite";
import type { Logger } from "@penumbra/core";

export function wrapDatabaseWithSlowQueryLog(
  db: Database,
  thresholdMs: number,
  log: Logger,
): Database {
  return new Proxy(db, {
    get(target, prop) {
      const orig = (target as any)[prop];
      if (typeof orig === "function") {
        if (prop === "prepare" || prop === "query") {
          return function (...args: any[]) {
            const stmt = orig.apply(target, args);
            const sql = args[0] as string;
            return wrapStatementWithSlowQueryLog(stmt, sql, thresholdMs, log);
          };
        } else if (prop === "exec" || prop === "run") {
          return function (...args: any[]) {
            const sql = args[0] as string;
            const start = performance.now();
            const res = orig.apply(target, args);
            const durationMs = performance.now() - start;
            if (durationMs > thresholdMs) {
              log.warn({ sql: sql.slice(0, 120), durationMs }, "slow query");
            }
            return res;
          };
        } else if (prop === "transaction") {
          return function (...args: any[]) {
            return orig.apply(target, args);
          };
        }
        return orig.bind(target);
      }
      return orig;
    },
  });
}

function wrapStatementWithSlowQueryLog(
  stmt: Statement,
  sql: string,
  thresholdMs: number,
  log: Logger,
): Statement {
  return new Proxy(stmt, {
    get(target, prop) {
      const orig = (target as any)[prop];
      if (typeof orig === "function" && ["run", "get", "all", "values"].includes(prop as string)) {
        return function (...args: any[]) {
          const start = performance.now();
          const res = orig.apply(target, args);
          const durationMs = performance.now() - start;
          if (durationMs > thresholdMs) {
            log.warn({ sql: sql.slice(0, 120), durationMs }, "slow query");
          }
          return res;
        };
      }
      if (typeof orig === "function") {
        return orig.bind(target);
      }
      return orig;
    },
  });
}
