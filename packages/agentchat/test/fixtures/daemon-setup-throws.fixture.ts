import { expect, mock, test } from "bun:test";

test("startInProcessDaemon throws synchronously when setup fails", async () => {
  const real = { ...(await import("@penumbra/core")) };
  await mock.module("@penumbra/core", () => ({
    ...real,
    loadSqliteVec: (): never => {
      throw new Error("fixture: loadSqliteVec unavailable");
    },
  }));
  const { startInProcessDaemon } = await import("../helpers/in-process-daemon.js");
  expect(() => startInProcessDaemon()).toThrow("fixture: loadSqliteVec unavailable");
});
