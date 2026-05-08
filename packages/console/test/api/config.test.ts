import { describe, expect, test } from "bun:test";
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
    const result = loadPenumbraConfig({ doc });
    expect(result).toEqual({ baseUrl: "http://127.0.0.1:51257", token: "abc" });
  });

  test("falls back to dev token + url when no meta tag", () => {
    const result = loadPenumbraConfig({
      doc: undefined,
      devToken: "devtok",
      devUrl: "http://localhost:51257",
    });
    expect(result).toEqual({
      baseUrl: "http://localhost:51257",
      token: "devtok",
    });
  });

  test("accepts and normalizes trailing-slash loopback URL", () => {
    const result = loadPenumbraConfig({
      doc: undefined,
      devToken: "devtok",
      devUrl: "http://127.0.0.1:51257/",
    });
    expect(result.baseUrl).toBe("http://127.0.0.1:51257");
  });

  test("rejects non-loopback baseUrl (no env-var escape hatch)", () => {
    expect(() =>
      loadPenumbraConfig({
        doc: undefined,
        devToken: "devtok",
        devUrl: "http://attacker.example.com",
      }),
    ).toThrow(BadDaemonUrlError);
    expect(() =>
      loadPenumbraConfig({
        doc: undefined,
        devToken: "devtok",
        devUrl: "https://127.0.0.1:51257",
      }),
    ).toThrow(BadDaemonUrlError);
    expect(() =>
      loadPenumbraConfig({
        doc: undefined,
        devToken: "devtok",
        devUrl: "http://127.0.0.1:51257/foo",
      }),
    ).toThrow(BadDaemonUrlError);
    expect(() =>
      loadPenumbraConfig({
        doc: undefined,
        devToken: "devtok",
        devUrl: "http://user:pass@127.0.0.1:51257",
      }),
    ).toThrow(BadDaemonUrlError);
  });

  test("throws MissingTokenError when token is empty", () => {
    expect(() =>
      loadPenumbraConfig({
        doc: undefined,
        devToken: "",
        devUrl: "http://127.0.0.1:51257",
      }),
    ).toThrow(MissingTokenError);
  });
});
