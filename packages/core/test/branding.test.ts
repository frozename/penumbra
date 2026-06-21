import { expect, test } from "bun:test";

import { Branding } from "../src/branding.js";

test("branding exposes product name, slug, and storage root", () => {
  expect(Branding.name).toBe("Penumbra");
  expect(Branding.slug).toBe("penumbra");
  expect(Branding.envPrefix).toBe("PENUMBRA");
  expect(Branding.storageRoot).toMatch(/\.penumbra$/);
});
