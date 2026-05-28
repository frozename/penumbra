import { expect, test } from "bun:test";
import { readSiriusEnv } from "../src/commands/sirius-env.js";

test("readSiriusEnv returns undefined when no vars are set", () => {
  expect(readSiriusEnv({})).toBeUndefined();
});

test("readSiriusEnv returns undefined if any of the four are missing", () => {
  expect(readSiriusEnv({ PENUMBRA_SIRIUS_BASE_URL: "http://x" })).toBeUndefined();
  expect(
    readSiriusEnv({
      PENUMBRA_SIRIUS_BASE_URL: "http://x",
      PENUMBRA_SIRIUS_TOKEN: "t",
      PENUMBRA_SIRIUS_MODEL: "m",
    }),
  ).toBeUndefined();
});

test("readSiriusEnv returns parsed opts when all four are set", () => {
  const opts = readSiriusEnv({
    PENUMBRA_SIRIUS_BASE_URL: "http://localhost:8080",
    PENUMBRA_SIRIUS_TOKEN: "tok",
    PENUMBRA_SIRIUS_MODEL: "text-embedding-3-small",
    PENUMBRA_SIRIUS_DIM: "1536",
  });
  expect(opts).toEqual({
    baseUrl: "http://localhost:8080",
    token: "tok",
    model: "text-embedding-3-small",
    dim: 1536,
  });
});

test("readSiriusEnv throws RangeError on invalid PENUMBRA_SIRIUS_DIM", () => {
  expect(() =>
    readSiriusEnv({
      PENUMBRA_SIRIUS_BASE_URL: "http://localhost:8080",
      PENUMBRA_SIRIUS_TOKEN: "tok",
      PENUMBRA_SIRIUS_MODEL: "m",
      PENUMBRA_SIRIUS_DIM: "abc",
    }),
  ).toThrow(RangeError);
  expect(() =>
    readSiriusEnv({
      PENUMBRA_SIRIUS_BASE_URL: "http://localhost:8080",
      PENUMBRA_SIRIUS_TOKEN: "tok",
      PENUMBRA_SIRIUS_MODEL: "m",
      PENUMBRA_SIRIUS_DIM: "0",
    }),
  ).toThrow(RangeError);
  expect(() =>
    readSiriusEnv({
      PENUMBRA_SIRIUS_BASE_URL: "http://localhost:8080",
      PENUMBRA_SIRIUS_TOKEN: "tok",
      PENUMBRA_SIRIUS_MODEL: "m",
      PENUMBRA_SIRIUS_DIM: "-1",
    }),
  ).toThrow(RangeError);
});
