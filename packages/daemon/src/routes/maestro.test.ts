import { expect, test } from "bun:test";
import { getMaestroCwd } from "./maestro.js";

// getMaestroCwd must read the configured main repo dir off the WorktreeManager,
// where it actually lives — reading it off the Services object itself always
// yields undefined and silently falls back to process.cwd().
test("getMaestroCwd reads mainRepoDir from the WorktreeManager, not process.cwd()", () => {
  const fakeRepoDir = "/tmp/penumbra-maestro-cwd-fixture";
  const services = { worktreeManager: { mainRepoDir: fakeRepoDir } } as never;

  // Guard the assertion is meaningful: the fixture must differ from the cwd.
  expect(fakeRepoDir).not.toBe(process.cwd());
  expect(getMaestroCwd(services)).toBe(fakeRepoDir);
});
