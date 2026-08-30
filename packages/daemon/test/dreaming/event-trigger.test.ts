import { getConfig, resetConfigForTest } from "@penumbra/config";
import { applySchema, loadSqliteVec } from "@penumbra/core";
import { buildDreamingConfig } from "@src/dreaming/config.js";
import { handleIdleSignal } from "@src/dreaming/event-trigger.js";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const noopLog: { warn: (msg: string) => void } = {
  warn: (_msg: string): void => undefined,
};

describe("dreaming/event-trigger", () => {
  let db: Database;

  beforeEach(() => {
    resetConfigForTest();
    db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
  });

  afterEach(() => {
    db.close();
  });

  it("drops when mutexHeld is true", async () => {
    const config = buildDreamingConfig(getConfig({}));
    await handleIdleSignal(db, config, { mutexHeld: true, log: noopLog });
    const count = db.prepare("SELECT COUNT(*) as c FROM dream_cycles").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("10 concurrent calls produce exactly 1 cycle", async () => {
    const config = buildDreamingConfig(getConfig({}));
    config.triggerCooldownMinutes = 0; // Disable cooldown for the test

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(handleIdleSignal(db, config, { mutexHeld: false, log: noopLog }));
    }
    await Promise.all(promises);

    const count = db.prepare("SELECT COUNT(*) as c FROM dream_cycles").get() as { c: number };
    expect(count.c).toBe(1);
  });
});
