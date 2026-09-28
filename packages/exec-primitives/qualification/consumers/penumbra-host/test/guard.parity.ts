/**
 * Resolution tripwire: inside the installed consumer copy, @penumbra/core must
 * resolve to the poison stub qualify.ts plants under tmp/sharedlib6/node_modules
 * — never the workspace sibling. A passing run proves consumer imports cannot
 * reach the repo's packages/* sources.
 */
import { expect, test } from "bun:test";

// The package import must load through the installed copy so the poison run
// reaches this file too — a GUARD that never touches the artifact cannot
// prove the rest of the suite does.
import "penumbra-exec-primitives";

test("[GUARD] importing @penumbra/core resolves to the poison stub, never the workspace", async () => {
  await expect(import("@penumbra/core")).rejects.toThrow(/resolution-guard/);
});
