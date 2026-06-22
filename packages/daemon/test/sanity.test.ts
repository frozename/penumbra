import { Branding } from "@penumbra/core";
import { expect, test } from "bun:test";

test("daemon package can import @penumbra/core", () => {
  expect(Branding.slug).toBe("penumbra");
});
