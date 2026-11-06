import { describe, expect, test } from "bun:test";

import { isLocalModelHost } from "@src/services/local-seat-health.js";

describe("isLocalModelHost", () => {
  test("a hostname in the configured set is local", () => {
    expect(isLocalModelHost("gpu-box", new Set(["gpu-box"]))).toBe(true);
    expect(isLocalModelHost("gpu-box", new Set<string>())).toBe(false);
  });

  test("configured-set match folds the input to lower case", () => {
    expect(isLocalModelHost("GPU-Box", new Set(["gpu-box"]))).toBe(true);
  });

  test("localhost is local regardless of case", () => {
    expect(isLocalModelHost("localhost", new Set<string>())).toBe(true);
    expect(isLocalModelHost("LocalHost", new Set<string>())).toBe(true);
  });

  test("the IPv6 loopback literal is local", () => {
    expect(isLocalModelHost("::1", new Set<string>())).toBe(true);
  });

  test("any 127.x address is local", () => {
    expect(isLocalModelHost("127.0.0.1", new Set<string>())).toBe(true);
    expect(isLocalModelHost("127.10.20.30", new Set<string>())).toBe(true);
  });

  test("192.168.x addresses are local", () => {
    expect(isLocalModelHost("192.168.1.50", new Set<string>())).toBe(true);
  });

  test("other private ranges are not local", () => {
    expect(isLocalModelHost("10.0.0.5", new Set<string>())).toBe(false);
    expect(isLocalModelHost("172.16.0.1", new Set<string>())).toBe(false);
  });

  test("a .local suffix is local and case-folded", () => {
    expect(isLocalModelHost("mac-mini.local", new Set<string>())).toBe(true);
    expect(isLocalModelHost("Mac-Mini.LOCAL", new Set<string>())).toBe(true);
    expect(isLocalModelHost("local", new Set<string>())).toBe(false);
  });

  test("a public hostname is not local", () => {
    expect(isLocalModelHost("api.example.com", new Set<string>())).toBe(false);
  });
});
