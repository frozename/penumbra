/**
 * Resolution tripwire: inside the installed consumer copy, @penumbra/core must
 * resolve to the poison stub qualify.ts plants under tmp/sharedlib6/node_modules
 * — never the workspace sibling. A passing run proves consumer imports cannot
 * reach the repo's packages/* sources.
 */
import { expect, test } from "bun:test";

test("[GUARD] importing @penumbra/core resolves to the poison stub, never the workspace", async () => {
  await expect(import("@penumbra/core")).rejects.toThrow(/resolution-guard/);
});
