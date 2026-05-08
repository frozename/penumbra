import { expect, test } from 'bun:test';
import type { GhClient as CanonicalGhClient } from '../../src/services/gh-client.js';
import type { GhClient as PrOrphanGhClient } from '../../src/sweepers/pr-orphan-sweeper.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

type CanonicalPrSubset = Required<Pick<CanonicalGhClient, 'listOpenPullRequests' | 'closePullRequest'>>;
const ghClientTypeUnificationAssert: Equal<PrOrphanGhClient, CanonicalPrSubset> = true;

test('pr-orphan sweeper uses canonical GhClient subset', () => {
  expect(ghClientTypeUnificationAssert).toBe(true);
});
