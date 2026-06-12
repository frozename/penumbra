import type { Database, Statement } from "bun:sqlite";
import type { Logger } from "@penumbra/core";

export function wrapDatabaseWithSlowQueryLog(
  db: Database,
  thresholdMs: number,
  log: Logger,
): Database {
  return new Proxy(db, {
    get(target, prop) {
      const original = (target as any)[prop];
      if (typeof original === "function") {
        if (prop === "prepare" || prop === "query") {
          return function (...args: any[]) {
            const stmt = original.apply(target, args);
            const sql = args[0] as string;
            return wrapStatementWithSlowQueryLog(stmt, sql, thresholdMs, log);
          };
        } else if (prop === "exec" || prop === "run") {
          return function (...args: any[]) {
            const sql = args[0] as string;
            const start = performance.now();
            const res = original.apply(target, args);
            const durationMs = performance.now() - start;
            if (durationMs > thresholdMs) {
              log.warn({ sql: sql.slice(0, 120), durationMs }, "slow query");
            }
            return res;
          };
        } else if (prop === "transaction") {
          return function (...args: any[]) {
            const transaction = original.apply(target, args);
            return wrapTransactionWithSlowQueryLog(transaction, thresholdMs, log);
          };
        }
        return original.bind(target);
      }
      return original;
    },
  });
}

function wrapTransactionWithSlowQueryLog(
  transaction: Function,
  thresholdMs: number,
  log: Logger,
): Function {
  const wrapped = wrapTransactionCall(transaction, "transaction", thresholdMs, log);

  for (const variant of ["default", "deferred", "immediate", "exclusive"]) {
    const descriptor = Object.getOwnPropertyDescriptor(transaction, variant);
    if (!descriptor) continue;
    const value = descriptor.value;
    if (typeof value !== "function") {
      Object.defineProperty(wrapped, variant, descriptor);
      continue;
    }
    Object.defineProperty(wrapped, variant, {
      ...descriptor,
      value: wrapTransactionCall(value, `transaction.${variant}`, thresholdMs, log),
    });
  }

  const databaseDescriptor = Object.getOwnPropertyDescriptor(transaction, "database");
  if (databaseDescriptor) {
    Object.defineProperty(wrapped, "database", databaseDescriptor);
  }

  return wrapped;
}

function wrapTransactionCall(
  transaction: Function,
  sql: string,
  thresholdMs: number,
  log: Logger,
): Function {
  return function (this: any, ...transactionArgs: any[]) {
    const start = performance.now();
    const res = transaction.apply(this, transactionArgs);
    const durationMs = performance.now() - start;
    if (durationMs > thresholdMs) {
      log.warn({ sql, durationMs }, "slow query");
    }
    return res;
  };
}

function wrapStatementWithSlowQueryLog(
  stmt: Statement,
  sql: string,
  thresholdMs: number,
  log: Logger,
): Statement {
  return new Proxy(stmt, {
    get(target, prop) {
      const original = (target as any)[prop];
      if (
        typeof original === "function" &&
        ["run", "get", "all", "values"].includes(prop as string)
      ) {
        return function (...args: any[]) {
          const start = performance.now();
          const res = original.apply(target, args);
          const durationMs = performance.now() - start;
          if (durationMs > thresholdMs) {
            log.warn({ sql: sql.slice(0, 120), durationMs }, "slow query");
          }
          return res;
        };
      }
      if (typeof original === "function") {
        return original.bind(target);
      }
      return original;
    },
  });
}
