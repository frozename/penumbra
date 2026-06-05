import { expect, test, spyOn } from "bun:test";
import { readEmbedderEnv } from "../src/commands/sirius-env.js";

test("readEmbedderEnv returns undefined when no vars are set", () => {
  expect(readEmbedderEnv({})).toBeUndefined();
});

test("readEmbedderEnv returns auto mode when only mode is set", () => {
  expect(readEmbedderEnv({ PENUMBRA_EMBEDDINGS_MODE: "auto" })).toEqual({ mode: "auto" });
});

test("readEmbedderEnv parses canonical remote config", () => {
  const opts = readEmbedderEnv({
    PENUMBRA_EMBEDDINGS_BASE_URL: "http://localhost:8080",
    PENUMBRA_EMBEDDINGS_MODEL: "text-embedding-3-small",
    PENUMBRA_EMBEDDINGS_DIM: "384",
    PENUMBRA_EMBEDDINGS_TOKEN: "tok",
    PENUMBRA_EMBEDDINGS_AUTH_HEADER: "x-api-key",
    PENUMBRA_EMBEDDINGS_AUTH_SCHEME: "ApiKey",
    PENUMBRA_EMBEDDINGS_HEALTH_PATH: "/readyz",
    PENUMBRA_EMBEDDINGS_MODE: "remote",
  });

  expect(opts).toEqual({
    mode: "remote",
    remote: {
      baseUrl: "http://localhost:8080",
      model: "text-embedding-3-small",
      dim: 384,
      token: "tok",
      authHeader: "x-api-key",
      authScheme: "ApiKey",
      healthPath: "/readyz",
    },
  });
});

test("readEmbedderEnv keeps empty healthPath to signal probe skip", () => {
  const opts = readEmbedderEnv({
    PENUMBRA_EMBEDDINGS_BASE_URL: "http://localhost:8080",
    PENUMBRA_EMBEDDINGS_MODEL: "m",
    PENUMBRA_EMBEDDINGS_DIM: "384",
    PENUMBRA_EMBEDDINGS_HEALTH_PATH: "",
    PENUMBRA_EMBEDDINGS_MODE: "auto",
  });

  expect(opts?.remote?.healthPath).toBe("");
});

test("readEmbedderEnv maps legacy PENUMBRA_SIRIUS_* vars and warns once", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const env = {
    PENUMBRA_SIRIUS_BASE_URL: "http://legacy:8080",
    PENUMBRA_SIRIUS_MODEL: "legacy-model",
    PENUMBRA_SIRIUS_DIM: "1536",
    PENUMBRA_SIRIUS_TOKEN: "legacy-token",
    PENUMBRA_EMBEDDER_PREFER_SIRIUS: "true",
  };

  const first = readEmbedderEnv(env);
  const second = readEmbedderEnv(env);

  expect(first).toEqual({
    mode: "auto",
    remote: {
      baseUrl: "http://legacy:8080",
      model: "legacy-model",
      dim: 1536,
      token: "legacy-token",
      authHeader: "Authorization",
      authScheme: "Bearer",
      healthPath: "/healthz",
    },
  });
  expect(second).toEqual(first);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("PENUMBRA_EMBEDDINGS_");

  warn.mockRestore();
});

test("readEmbedderEnv throws in remote mode when baseUrl is missing", () => {
  expect(() =>
    readEmbedderEnv({
      PENUMBRA_EMBEDDINGS_MODE: "remote",
      PENUMBRA_EMBEDDINGS_MODEL: "m",
      PENUMBRA_EMBEDDINGS_DIM: "384",
    }),
  ).toThrow(/BASE_URL/);
});

test("readEmbedderEnv throws on invalid PENUMBRA_EMBEDDINGS_DIM", () => {
  expect(() =>
    readEmbedderEnv({
      PENUMBRA_EMBEDDINGS_BASE_URL: "http://localhost:8080",
      PENUMBRA_EMBEDDINGS_MODEL: "m",
      PENUMBRA_EMBEDDINGS_DIM: "abc",
    }),
  ).toThrow(RangeError);
});
