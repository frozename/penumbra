import { describe, expect, test } from "bun:test";
import {
  BadDaemonUrlError,
  MissingTokenError,
  loadPenumbraConfig,
} from "../../src/api/config";

describe("loadPenumbraConfig", () => {
  test("production mode returns /api baseUrl with empty token", () => {
    const result = loadPenumbraConfig({ isDev: false });
    expect(result).toEqual({ baseUrl: "/api", token: "" });
  });

  test("dev mode with valid loopback URL and token", () => {
    const result = loadPenumbraConfig({
      isDev: true,
      devUrl: "http://127.0.0.1:51257",
      devToken: "devtok",
    });
    expect(result).toEqual({
      baseUrl: "http://127.0.0.1:51257",
      token: "devtok",
    });
  });

  test("dev mode accepts localhost", () => {
    const result = loadPenumbraConfig({
      isDev: true,
      devUrl: "http://localhost:51257",
      devToken: "devtok",
    });
    expect(result).toEqual({
      baseUrl: "http://localhost:51257",
      token: "devtok",
    });
  });

  test("dev mode normalizes trailing slash", () => {
    const result = loadPenumbraConfig({
      isDev: true,
      devUrl: "http://127.0.0.1:51257/",
      devToken: "devtok",
    });
    expect(result.baseUrl).toBe("http://127.0.0.1:51257");
  });

  test("dev mode rejects non-loopback URL", () => {
    expect(() =>
      loadPenumbraConfig({
        isDev: true,
        devToken: "devtok",
        devUrl: "http://attacker.example.com",
      }),
    ).toThrow(BadDaemonUrlError);
  });

  test("dev mode rejects https URL", () => {
    expect(() =>
      loadPenumbraConfig({
        isDev: true,
        devToken: "devtok",
        devUrl: "https://127.0.0.1:51257",
      }),
    ).toThrow(BadDaemonUrlError);
  });

  test("dev mode rejects path in URL", () => {
    expect(() =>
      loadPenumbraConfig({
        isDev: true,
        devToken: "devtok",
        devUrl: "http://127.0.0.1:51257/foo",
      }),
    ).toThrow(BadDaemonUrlError);
  });

  test("dev mode rejects URL with credentials", () => {
    expect(() =>
      loadPenumbraConfig({
        isDev: true,
        devToken: "devtok",
        devUrl: "http://user:pass@127.0.0.1:51257",
      }),
    ).toThrow(BadDaemonUrlError);
  });

  test("dev mode throws MissingTokenError when token is empty", () => {
    expect(() =>
      loadPenumbraConfig({
        isDev: true,
        devToken: "",
        devUrl: "http://127.0.0.1:51257",
      }),
    ).toThrow(MissingTokenError);
  });
});
