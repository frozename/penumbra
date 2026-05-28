import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { makeSandbox } from "./sandbox.js";

test("makeSandbox creates an existing directory under the system tmp dir", () => {
  const sb = makeSandbox();
  try {
    expect(existsSync(sb.dir)).toBe(true);
    expect(statSync(sb.dir).isDirectory()).toBe(true);
    expect(sb.dir).toMatch(/penumbra-e2e-/);
  } finally {
    sb.cleanup();
  }
});

test("makeSandbox.cleanup removes the directory", () => {
  const sb = makeSandbox();
  expect(existsSync(sb.dir)).toBe(true);
  sb.cleanup();
  expect(existsSync(sb.dir)).toBe(false);
});

test("makeSandbox accepts a custom prefix", () => {
  const sb = makeSandbox("penumbra-custom-");
  try {
    expect(sb.dir).toMatch(/penumbra-custom-/);
  } finally {
    sb.cleanup();
  }
});
