import { expect, test } from "bun:test";

import * as envMod from "../src/env.js";

test("ENV_REGISTRY registers PENUMBRA_ALLOW_MIGRATE for the schema-49 cutover gate", () => {
  const entry = envMod.ENV_REGISTRY.PENUMBRA_ALLOW_MIGRATE;
  expect(entry).toBeDefined();
  expect(entry?.description).toBeTruthy();
  expect(entry?.description).toContain("schema-49-cutover");
  expect(entry?.isSensitive).not.toBe(true);
});
