import { emitSessionReminder } from "@src/outputs/session-reminder.js";
import { expect, test } from "bun:test";

test("emitSessionReminder returns the right shape", () => {
  expect(emitSessionReminder({ text: "hello" })).toEqual({
    kind: "session-reminder",
    text: "hello",
  });
});
