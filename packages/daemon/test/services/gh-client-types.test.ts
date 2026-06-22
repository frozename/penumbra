import { expect, test } from "bun:test";

import type { GhClient as CanonicalGhClient } from "../../src/services/gh-client.js";
import type { GhClient as PrOrphanGhClient } from "../../src/sweepers/pr-orphan-sweeper.js";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type CanonicalPrSubset = Required<
  Pick<CanonicalGhClient, "listOpenPullRequests" | "closePullRequest">
>;
const ghClientTypeUnificationAssert: Equal<PrOrphanGhClient, CanonicalPrSubset> = true;

test("pr-orphan sweeper uses canonical GhClient subset", () => {
  expect(ghClientTypeUnificationAssert).toBe(true);
});
