import { expect, test } from "bun:test";

import { isLoopbackBindHost } from "@src/origin-host.js";

test("IPv4 loopback across the 127/8 block is loopback", () => {
  expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
  expect(isLoopbackBindHost("127.0.0.53")).toBe(true);
});

test("localhost is loopback", () => {
  expect(isLoopbackBindHost("localhost")).toBe(true);
});

test("IPv6 loopback, bare and bracketed, is loopback", () => {
  expect(isLoopbackBindHost("::1")).toBe(true);
  expect(isLoopbackBindHost("[::1]")).toBe(true);
});

test("surrounding whitespace is trimmed before matching", () => {
  expect(isLoopbackBindHost("  127.0.0.1  ")).toBe(true);
  expect(isLoopbackBindHost("\tlocalhost\n")).toBe(true);
});

test("wildcard binds are not loopback", () => {
  expect(isLoopbackBindHost("0.0.0.0")).toBe(false);
  expect(isLoopbackBindHost("::")).toBe(false);
});

test("LAN address is not loopback", () => {
  expect(isLoopbackBindHost("192.168.1.10")).toBe(false);
});

test("suffix-spoofed names are not loopback (pattern is anchored)", () => {
  expect(isLoopbackBindHost("localhost.evil.com")).toBe(false);
  expect(isLoopbackBindHost("127.0.0.1.evil.com")).toBe(false);
});

test("empty string is not loopback", () => {
  expect(isLoopbackBindHost("")).toBe(false);
});
