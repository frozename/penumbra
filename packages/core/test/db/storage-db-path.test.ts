import { describe, expect, test } from "bun:test";

import { assertTestDbPathIsolation, resolveStorageDbPath } from "@src/db/storage-db-path.js";

describe("resolveStorageDbPath", () => {
  test("joins db.sqlite onto a non-production storage root", () => {
    expect(resolveStorageDbPath("/srv/store", { env: {} })).toBe("/srv/store/db.sqlite");
  });

  test("throws on the production db path under NODE_ENV=test", () => {
    expect(() =>
      resolveStorageDbPath("/fake-home/.penumbra", {
        env: { NODE_ENV: "test" },
        homeDir: "/fake-home",
      }),
    ).toThrow(
      /refusing to open production database path[\s\S]*\/fake-home\/\.penumbra\/db\.sqlite/,
    );
  });

  test("allows the production db path under NODE_ENV=production", () => {
    expect(
      resolveStorageDbPath("/fake-home/.penumbra", {
        env: { NODE_ENV: "production" },
        homeDir: "/fake-home",
      }),
    ).toBe("/fake-home/.penumbra/db.sqlite");
  });

  test("allows the production db path when NODE_ENV is unset", () => {
    expect(
      resolveStorageDbPath("/fake-home/.penumbra", {
        env: {},
        homeDir: "/fake-home",
      }),
    ).toBe("/fake-home/.penumbra/db.sqlite");
  });

  test("allows a non-production storage root under NODE_ENV=test", () => {
    expect(
      resolveStorageDbPath("/fake-home/.penumbra-test", {
        env: { NODE_ENV: "test" },
        homeDir: "/fake-home",
      }),
    ).toBe("/fake-home/.penumbra-test/db.sqlite");
  });
});

describe("assertTestDbPathIsolation", () => {
  test("normalises the path before comparing", () => {
    expect(() => {
      assertTestDbPathIsolation("/fake-home/x/../.penumbra/db.sqlite", {
        env: { NODE_ENV: "test" },
        homeDir: "/fake-home",
      });
    }).toThrow();
  });

  test("falls back to env.HOME when homeDir is omitted", () => {
    expect(() => {
      assertTestDbPathIsolation("/env-home/.penumbra/db.sqlite", {
        env: { NODE_ENV: "test", HOME: "/env-home" },
      });
    }).toThrow();
  });

  test("explicit homeDir wins over env.HOME", () => {
    expect(() => {
      assertTestDbPathIsolation("/env-home/.penumbra/db.sqlite", {
        env: { NODE_ENV: "test", HOME: "/env-home" },
        homeDir: "/fake-home",
      });
    }).not.toThrow();
  });

  test("does not flag a different filename in the production directory", () => {
    expect(() => {
      assertTestDbPathIsolation("/fake-home/.penumbra/other.sqlite", {
        env: { NODE_ENV: "test" },
        homeDir: "/fake-home",
      });
    }).not.toThrow();
  });
});
