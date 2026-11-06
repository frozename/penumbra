import { describe, expect, test } from "bun:test";

import { readEmbedderEnv } from "../src/commands/embedder-env.js";

const REMOTE = {
  PENUMBRA_EMBEDDINGS_BASE_URL: "http://localhost:8080",
  PENUMBRA_EMBEDDINGS_MODEL: "m",
};

describe("readEmbedderEnv rules", () => {
  test("bundled mode returns mode only, with no remote key", () => {
    const result = readEmbedderEnv({ ...REMOTE, PENUMBRA_EMBEDDINGS_MODE: "bundled" });
    expect(result).toEqual({ mode: "bundled" });
    if (result === undefined) throw new Error("expected config");
    expect("remote" in result).toBe(false);
  });

  test("invalid mode name lists the legal values and the got value", () => {
    expect(() => readEmbedderEnv({ PENUMBRA_EMBEDDINGS_MODE: "hybrid" })).toThrow(
      /bundled\|remote\|auto/,
    );
    expect(() => readEmbedderEnv({ PENUMBRA_EMBEDDINGS_MODE: "hybrid" })).toThrow(/'hybrid'/);
  });

  test("empty mode string is not defaulted by ??", () => {
    expect(() => readEmbedderEnv({ PENUMBRA_EMBEDDINGS_MODE: "" })).toThrow(/got ''/);
  });

  test("remote mode without MODEL throws the MODE=remote message", () => {
    expect(() =>
      readEmbedderEnv({
        PENUMBRA_EMBEDDINGS_MODE: "remote",
        PENUMBRA_EMBEDDINGS_BASE_URL: "http://localhost:8080",
      }),
    ).toThrow(/MODEL is required when PENUMBRA_EMBEDDINGS_MODE=remote/);
  });

  test("auto mode with BASE_URL and no MODEL throws the BASE_URL-set message, not the remote one", () => {
    let threw = false;
    try {
      readEmbedderEnv({ PENUMBRA_EMBEDDINGS_BASE_URL: "http://localhost:8080" });
    } catch (err) {
      threw = true;
      if (!(err instanceof Error)) throw err;
      expect(err.message).toMatch(/MODEL is required when PENUMBRA_EMBEDDINGS_BASE_URL is set/);
      expect(err.message).not.toMatch(/MODE=remote/);
    }
    expect(threw).toBe(true);
  });

  test("token alone yields auto mode with no remote config", () => {
    const result = readEmbedderEnv({ PENUMBRA_EMBEDDINGS_TOKEN: "t" });
    expect(result).toEqual({ mode: "auto" });
    expect(result?.remote).toBeUndefined();
  });

  test("baseUrl+model apply defaults for dim, auth and health settings", () => {
    const result = readEmbedderEnv({ ...REMOTE });
    expect(result).toEqual({
      mode: "auto",
      remote: {
        baseUrl: "http://localhost:8080",
        model: "m",
        dim: 384,
        token: undefined,
        authHeader: "Authorization",
        authScheme: "Bearer",
        healthPath: "/healthz",
      },
    });
    expect(result?.remote?.dim).toBe(384);
    expect(result?.remote?.authHeader).toBe("Authorization");
    expect(result?.remote?.authScheme).toBe("Bearer");
    expect(result?.remote?.healthPath).toBe("/healthz");
    expect(result?.remote?.token).toBeUndefined();
  });

  test("dim 0 throws RangeError with the positive-integer message", () => {
    expect(() => readEmbedderEnv({ ...REMOTE, PENUMBRA_EMBEDDINGS_DIM: "0" })).toThrow(RangeError);
    expect(() => readEmbedderEnv({ ...REMOTE, PENUMBRA_EMBEDDINGS_DIM: "0" })).toThrow(
      "PENUMBRA_EMBEDDINGS_DIM must be a positive integer, got '0'",
    );
  });

  test("negative dim throws RangeError", () => {
    expect(() => readEmbedderEnv({ ...REMOTE, PENUMBRA_EMBEDDINGS_DIM: "-5" })).toThrow(RangeError);
  });

  test("non-integer dim throws RangeError", () => {
    expect(() => readEmbedderEnv({ ...REMOTE, PENUMBRA_EMBEDDINGS_DIM: "1.5" })).toThrow(
      RangeError,
    );
  });

  test("valid dim parses to a number", () => {
    const result = readEmbedderEnv({ ...REMOTE, PENUMBRA_EMBEDDINGS_DIM: "1536" });
    expect(result?.remote?.dim).toBe(1536);
    expect(typeof result?.remote?.dim).toBe("number");
  });
});
