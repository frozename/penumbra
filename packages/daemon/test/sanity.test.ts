import { expect, test } from "bun:test";
import { Branding } from "@penumbra/core";

test("daemon package can import @penumbra/core", () => {
  expect(Branding.slug).toBe("penumbra");
});
