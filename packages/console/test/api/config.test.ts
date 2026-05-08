import { describe, expect, test, spyOn } from "bun:test";
import {
  BadDaemonUrlError,
  MissingTokenError,
  loadPenumbraConfig,
} from "../../src/api/config";

function makeDoc(content: string | null): Document {
  return {
    querySelector: (_sel: string) =>
      content === null
        ? null
        : ({ getAttribute: (_n: string) => content } as unknown as Element),
  } as unknown as Document;
}

describe("loadPenumbraConfig", () => {
  test("uses meta tag when present and well-formed", () => {
    const doc = makeDoc(
      JSON.stringify({ baseUrl: "http://127.0.0.1:51257", token: "abc" }),
    );
    const result = loadPenumbraConfig({ doc, env: {} });
    expect(result).toEqual({ baseUrl: "http://127.0.0.1:51257", token: "abc" });
  });

  test("falls back to dev token + url when no meta tag", () => {
    const result = loadPenumbraConfig({
      doc: undefined,
      env: {},
      devToken: "devtok",
      devUrl: "http://localhost:51257",
    });
    expect(result).toEqual({
      baseUrl: "http://localhost:51257",
      token: "devtok",
    });
  });

  test("rejects foreign baseUrl without allow-remote", () => {
    expect(() =>
      loadPenumbraConfig({
        doc: undefined,
        env: { VITE_PENUMBRA_ALLOW_REMOTE: undefined },
        devToken: "devtok",
        devUrl: "http://attacker.example.com",
      }),
    ).toThrow(BadDaemonUrlError);
  });

  test("allows foreign baseUrl when VITE_PENUMBRA_ALLOW_REMOTE=1, warns once", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = loadPenumbraConfig({
        doc: undefined,
        env: { VITE_PENUMBRA_ALLOW_REMOTE: "1" },
        devToken: "devtok",
        devUrl: "http://attacker.example.com",
      });
      expect(result.baseUrl).toBe("http://attacker.example.com");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("throws MissingTokenError when token is empty", () => {
    expect(() =>
      loadPenumbraConfig({
        doc: undefined,
        env: {},
        devToken: "",
        devUrl: "http://127.0.0.1:51257",
      }),
    ).toThrow(MissingTokenError);
  });
});
