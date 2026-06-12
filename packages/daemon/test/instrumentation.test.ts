import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { LagSampler } from "../src/lag-sampler.js";
import { createDaemonFetchHandler } from "../src/serve.js";
import { wrapDatabaseWithSlowQueryLog } from "../src/slow-query.js";

describe("instrumentation integration", () => {
  afterEach(() => {
    mock.restore();
  });

  test("lag sampler records max lag and logs warn with a fake clock", () => {
    let warnFields: any = null;
    let warnMsg: string | null = null;
    const fakeLog = {
      warn: (fields: any, msg: string) => {
        warnFields = fields;
        warnMsg = msg;
      },
    };

    let nowMs = 1000;
    const sampler = new LagSampler(fakeLog as any, 20, 10, () => nowMs);
    sampler.start();

    nowMs += 35;
    sampler.sample();

    expect(sampler.maxLagMs).toBe(25);
    expect(warnFields).not.toBeNull();
    expect(warnFields.lagMs).toBe(25);
    expect(warnFields.thresholdMs).toBe(20);
    expect(warnMsg).toBe("event-loop lag exceeded threshold");

    sampler.stop();
  });

  test("lag sampler ignores wall-clock jumps when measuring interval drift", () => {
    const originalDateNow = Date.now;
    const originalPerfNow = performance.now;
    let wallNowMs = 1_000_000;
    let monotonicNowMs = 2_000;
    Object.defineProperty(Date, "now", {
      value: () => wallNowMs,
      writable: true,
    });
    Object.defineProperty(performance, "now", {
      value: () => monotonicNowMs,
      writable: true,
    });

    const sampler = new LagSampler({ warn: () => undefined } as any, 20, 10);

    try {
      sampler.start();
      wallNowMs += 10_000;
      monotonicNowMs += 10;

      expect(sampler.sample()).toBe(0);
    } finally {
      sampler.stop();
      Object.defineProperty(Date, "now", {
        value: originalDateNow,
        writable: true,
      });
      Object.defineProperty(performance, "now", {
        value: originalPerfNow,
        writable: true,
      });
    }
  });

  test("health handler exposes event loop lag rolling max from sampler without resetting reads", async () => {
    const rawDb = new Database(":memory:");
    loadSqliteVec(rawDb);
    migrate(rawDb, { embeddingDim: 384 });

    let nowMs = 2000;
    const sampler = new LagSampler({ warn: () => undefined } as any, 20, 10, () => nowMs);
    sampler.start();
    nowMs += 45;
    sampler.sample();

    const services = buildServices({
      env: {},
      input: {},
      storageRoot: "/tmp",
      db: rawDb,
      embedder: new TestEmbedder({ dim: 384 }),
    });
    const handler = createDaemonFetchHandler({
      services,
      token: "test-token",
      lagSampler: sampler,
    });

    try {
      const res = await handler(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.status).toBe("ok");
      expect(body.lagMs).toBe(35);

      const secondRes = await handler(new Request("http://localhost/health"));
      const secondBody = (await secondRes.json()) as Record<string, unknown>;
      expect(secondBody.lagMs).toBe(35);

      nowMs += 60_001;

      const agedOutRes = await handler(new Request("http://localhost/health"));
      const agedOutBody = (await agedOutRes.json()) as Record<string, unknown>;
      expect(agedOutBody.lagMs).toBe(0);
    } finally {
      sampler.stop();
      services.supervisor.stopAll();
      rawDb.close();
    }
  });

  test("slow query wrapper logs statements exceeding threshold", () => {
    let logged: any = null;
    const fakeLog = {
      warn: (fields: any, msg: string) => {
        logged = fields;
      },
    };

    const rawDb = new Database(":memory:");
    rawDb.run("CREATE TABLE foo(id INT);");

    const db = wrapDatabaseWithSlowQueryLog(rawDb, 50, fakeLog as any);

    // Mock performance.now()
    const originalPerfNow = performance.now;
    let nowValue = 1000;
    Object.defineProperty(performance, "now", {
      value: () => nowValue,
      writable: true,
    });

    try {
      const stmt = db.prepare("INSERT INTO foo VALUES (1)");

      // Simulate taking 60ms
      const originalRun = stmt.run;
      stmt.run = (...args: any[]) => {
        nowValue += 60;
        return originalRun.apply(stmt, args);
      };

      stmt.run();

      expect(logged).not.toBeNull();
      expect(logged.sql).toMatch(/^INSERT INTO foo/);
      expect(logged.durationMs).toBe(60);
    } finally {
      Object.defineProperty(performance, "now", {
        value: originalPerfNow,
        writable: true,
      });
    }
  });

  test("slow query wrapper logs transactions exceeding threshold", () => {
    let logged: any = null;
    const fakeLog = {
      warn: (fields: any) => {
        logged = fields;
      },
    };

    const rawDb = new Database(":memory:");
    rawDb.run("CREATE TABLE foo(id INT);");
    const db = wrapDatabaseWithSlowQueryLog(rawDb, 50, fakeLog as any);

    const originalPerfNow = performance.now;
    let nowValue = 1000;
    Object.defineProperty(performance, "now", {
      value: () => nowValue,
      writable: true,
    });

    try {
      const tx = db.transaction(() => {
        nowValue += 60;
        db.prepare("INSERT INTO foo VALUES (1)").run();
      });

      tx();

      expect(logged).not.toBeNull();
      expect(logged.sql).toBe("transaction");
      expect(logged.durationMs).toBe(60);
    } finally {
      Object.defineProperty(performance, "now", {
        value: originalPerfNow,
        writable: true,
      });
      rawDb.close();
    }
  });

  test("slow query wrapper preserves and logs transaction variants", () => {
    const logged: any[] = [];
    const fakeLog = {
      warn: (fields: any) => {
        logged.push(fields);
      },
    };

    const rawDb = new Database(":memory:");
    rawDb.run("CREATE TABLE foo(id INT);");
    const db = wrapDatabaseWithSlowQueryLog(rawDb, 50, fakeLog as any);

    const originalPerfNow = performance.now;
    let nowValue = 1000;
    Object.defineProperty(performance, "now", {
      value: () => nowValue,
      writable: true,
    });

    try {
      const tx = db.transaction((id: number) => {
        nowValue += 60;
        db.prepare("INSERT INTO foo VALUES (?)").run(id);
      });

      expect(typeof (tx as any).deferred).toBe("function");
      expect(typeof (tx as any).immediate).toBe("function");
      expect(typeof (tx as any).exclusive).toBe("function");

      (tx as any).deferred(1);
      (tx as any).immediate(2);
      (tx as any).exclusive(3);

      expect(rawDb.query("SELECT COUNT(*) AS n FROM foo").get()).toEqual({ n: 3 });
      expect(logged).toEqual([
        { sql: "transaction.deferred", durationMs: 60 },
        { sql: "transaction.immediate", durationMs: 60 },
        { sql: "transaction.exclusive", durationMs: 60 },
      ]);
    } finally {
      Object.defineProperty(performance, "now", {
        value: originalPerfNow,
        writable: true,
      });
      rawDb.close();
    }
  });
});
