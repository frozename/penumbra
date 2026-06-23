import type { Logger } from "@penumbra/core";
import type { Changes, Database, SQLQueryBindings, Statement } from "bun:sqlite";

type UnknownMethod = (this: object, ...args: unknown[]) => unknown;
type InstrumentedStatement = Statement<unknown, SQLQueryBindings[]>;
type SqliteDatabaseRestBindings = SQLQueryBindings[][];
type TransactionFn<Args extends unknown[], Result> = ((...args: Args) => Result) & {
  deferred: (...args: Args) => Result;
  exclusive: (...args: Args) => Result;
  immediate: (...args: Args) => Result;
};

const STATEMENT_METHODS_TO_LOG = new Set<PropertyKey>(["all", "get", "run", "values"]);

function getProperty(target: object, prop: string | symbol): unknown {
  return (target as Record<PropertyKey, unknown>)[prop];
}

function isUnknownMethod(value: unknown): value is UnknownMethod {
  return typeof value === "function";
}

function toInstrumentedStatement(value: unknown): InstrumentedStatement {
  return value as InstrumentedStatement;
}

function toSqliteDatabaseRestBindings(bindings: unknown[]): SqliteDatabaseRestBindings {
  return bindings as SqliteDatabaseRestBindings;
}

export function wrapDatabaseWithSlowQueryLog(
  db: Database,
  thresholdMs: number,
  log: Logger,
): Database {
  return new Proxy(db, {
    get(target, prop): unknown {
      if (prop === "prepare") {
        return function (sql: string, params?: SQLQueryBindings | SQLQueryBindings[]): Statement {
          const stmt: unknown = target.prepare(sql, params);
          return wrapStatementWithSlowQueryLog(
            toInstrumentedStatement(stmt),
            sql,
            thresholdMs,
            log,
          );
        };
      }

      if (prop === "query") {
        return function (sql: string): Statement {
          const stmt: unknown = target.query(sql);
          return wrapStatementWithSlowQueryLog(
            toInstrumentedStatement(stmt),
            sql,
            thresholdMs,
            log,
          );
        };
      }

      if (prop === "exec") {
        return function (sql: string, ...bindings: unknown[]): Changes {
          const start = performance.now();
          const res = target.run(sql, ...toSqliteDatabaseRestBindings(bindings));
          const durationMs = performance.now() - start;
          if (durationMs > thresholdMs) {
            log.warn({ sql: sql.slice(0, 120), durationMs }, "slow query");
          }
          return res;
        };
      }

      if (prop === "run") {
        return function (sql: string, ...bindings: unknown[]): Changes {
          const start = performance.now();
          const res = target.run(sql, ...toSqliteDatabaseRestBindings(bindings));
          const durationMs = performance.now() - start;
          if (durationMs > thresholdMs) {
            log.warn({ sql: sql.slice(0, 120), durationMs }, "slow query");
          }
          return res;
        };
      }

      if (prop === "transaction") {
        return function <Args extends unknown[], Result>(
          insideTransaction: (...args: Args) => Result,
        ): TransactionFn<Args, Result> {
          const transaction = target.transaction(insideTransaction);
          return wrapTransactionWithSlowQueryLog(transaction, thresholdMs, log);
        };
      }

      const original = getProperty(target, prop);
      if (isUnknownMethod(original)) {
        return original.bind(target);
      }
      return original;
    },
  });
}

function wrapTransactionWithSlowQueryLog<Args extends unknown[], Result>(
  transaction: TransactionFn<Args, Result>,
  thresholdMs: number,
  log: Logger,
): TransactionFn<Args, Result> {
  const wrapped = wrapTransactionCall(transaction, "transaction", thresholdMs, log);

  for (const variant of ["default", "deferred", "immediate", "exclusive"]) {
    const descriptor = Object.getOwnPropertyDescriptor(transaction, variant);
    if (!descriptor) continue;
    const value: unknown = descriptor.value;
    if (!isUnknownMethod(value)) {
      Object.defineProperty(wrapped, variant, descriptor);
      continue;
    }
    Object.defineProperty(wrapped, variant, {
      ...descriptor,
      value: wrapTransactionCall(
        value as (...args: Args) => Result,
        `transaction.${variant}`,
        thresholdMs,
        log,
      ),
    });
  }

  const databaseDescriptor = Object.getOwnPropertyDescriptor(transaction, "database");
  if (databaseDescriptor) {
    Object.defineProperty(wrapped, "database", databaseDescriptor);
  }

  return wrapped as TransactionFn<Args, Result>;
}

function wrapTransactionCall<Args extends unknown[], Result>(
  transaction: (...args: Args) => Result,
  sql: string,
  thresholdMs: number,
  log: Logger,
): (...args: Args) => Result {
  return function (this: object, ...transactionArgs: Args): Result {
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
  stmt: InstrumentedStatement,
  sql: string,
  thresholdMs: number,
  log: Logger,
): InstrumentedStatement {
  return new Proxy(stmt, {
    get(target, prop): unknown {
      if (STATEMENT_METHODS_TO_LOG.has(prop)) {
        return wrapStatementMethod(target, prop, sql, thresholdMs, log);
      }

      const original = getProperty(target, prop);
      if (isUnknownMethod(original)) {
        return original.bind(target);
      }
      return original;
    },
  });
}

function wrapStatementMethod(
  target: InstrumentedStatement,
  prop: string | symbol,
  sql: string,
  thresholdMs: number,
  log: Logger,
): unknown {
  const original = getProperty(target, prop);
  if (!isUnknownMethod(original)) return original;

  return function (...params: SQLQueryBindings[]): unknown {
    const start = performance.now();
    const res = original.apply(target, params);
    const durationMs = performance.now() - start;
    if (durationMs > thresholdMs) {
      log.warn({ sql: sql.slice(0, 120), durationMs }, "slow query");
    }
    return res;
  };
}
