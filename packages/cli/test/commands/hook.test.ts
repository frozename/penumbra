import { expect, test } from "bun:test";

import { claudeCodeEventToLifecycle, lifecycleToHookEventName } from "@src/commands/hook.js";

test("claudeCodeEventToLifecycle('SessionEnd') -> 'session-end'", () => {
  expect(claudeCodeEventToLifecycle("SessionEnd")).toBe("session-end");
});

test("lifecycleToHookEventName('session-end') -> 'SessionEnd'", () => {
  expect(lifecycleToHookEventName("session-end")).toBe("SessionEnd");
});
