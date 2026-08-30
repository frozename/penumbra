import { describe, expect, test } from "bun:test";

import {
  assessWorkerCodeStaleness,
  shouldCheckWorkerCodeStaleness,
  WORKER_CODE_SHA_GIT_TIMEOUT_MS,
  WORKER_CODE_STALENESS_CHECK_INTERVAL_MS,
  resolveWorkerCodeShaAsync,
  resolveWorkerCodeSha,
} from "../../src/worker/code-staleness.js";

describe("worker code staleness", () => {
  test("reports stale when boot sha differs from current repo HEAD sha", () => {
    expect(
      assessWorkerCodeStaleness({
        bootSha: "a".repeat(40),
        currentSha: "b".repeat(40),
      }),
    ).toEqual({ status: "stale", stale: true });
  });

  test("reports not stale when boot sha matches current repo HEAD sha", () => {
    expect(
      assessWorkerCodeStaleness({
        bootSha: "a".repeat(40),
        currentSha: "a".repeat(40),
      }),
    ).toEqual({ status: "current", stale: false });
  });

  test("reports indeterminate, never false stale, when sha resolution fails", () => {
    const resolved = resolveWorkerCodeSha("/not-a-repo", {
      execFileSync: (): never => {
        throw new Error("git unavailable");
      },
    });

    expect(resolved).toEqual({ status: "unknown", sha: null, reason: "git unavailable" });
    expect(
      assessWorkerCodeStaleness({
        bootSha: "a".repeat(40),
        currentSha: resolved.sha,
      }),
    ).toEqual({ status: "unknown", stale: false });
  });

  test("passes a bounded timeout to git and reports timeout as unknown", () => {
    const timeoutError = new Error("spawnSync git ETIMEDOUT");
    const resolved = resolveWorkerCodeSha("/repo", {
      execFileSync: (_file, _args, options): never => {
        expect(options).toMatchObject({
          timeout: WORKER_CODE_SHA_GIT_TIMEOUT_MS,
          killSignal: "SIGKILL",
        });
        throw timeoutError;
      },
    });

    expect(resolved).toEqual({
      status: "unknown",
      sha: null,
      reason: "spawnSync git ETIMEDOUT",
    });
  });

  test("sanitizes credential-bearing git URLs from sha resolution failures", () => {
    const resolved = resolveWorkerCodeSha("/repo", {
      execFileSync: (): never => {
        throw new Error(
          "fatal: could not read from https://user:token@example.com/org/private.git",
        );
      },
    });

    expect(resolved).toEqual({
      status: "unknown",
      sha: null,
      reason: "fatal: could not read from https://example.com/org/private.git",
    });
    if (resolved.status !== "unknown") throw new Error("expected unknown sha status");
    expect(resolved.reason).not.toContain("user:token");
  });

  test("resolves worker code sha asynchronously with the same timeout bound", async () => {
    const resolved = await resolveWorkerCodeShaAsync("/repo", {
      execFile: (_file, _args, options, callback): void => {
        expect(options).toMatchObject({
          timeout: WORKER_CODE_SHA_GIT_TIMEOUT_MS,
          killSignal: "SIGKILL",
        });
        callback(null, `${"A".repeat(40)}\n`, "");
      },
    });

    expect(resolved).toEqual({ status: "resolved", sha: "a".repeat(40) });
  });

  test("throttles healthy worker code staleness checks to the named interval boundaries", () => {
    const first = 1_000;

    expect(
      shouldCheckWorkerCodeStaleness({
        lastCheckedAtMs: null,
        nowMs: first,
        intervalMs: WORKER_CODE_STALENESS_CHECK_INTERVAL_MS,
      }),
    ).toBe(true);
    expect(
      shouldCheckWorkerCodeStaleness({
        lastCheckedAtMs: first,
        nowMs: first + WORKER_CODE_STALENESS_CHECK_INTERVAL_MS - 1,
        intervalMs: WORKER_CODE_STALENESS_CHECK_INTERVAL_MS,
      }),
    ).toBe(false);
    expect(
      shouldCheckWorkerCodeStaleness({
        lastCheckedAtMs: first,
        nowMs: first - 1,
        intervalMs: WORKER_CODE_STALENESS_CHECK_INTERVAL_MS,
      }),
    ).toBe(true);
    expect(
      shouldCheckWorkerCodeStaleness({
        lastCheckedAtMs: first,
        nowMs: first + WORKER_CODE_STALENESS_CHECK_INTERVAL_MS,
        intervalMs: WORKER_CODE_STALENESS_CHECK_INTERVAL_MS,
      }),
    ).toBe(true);
  });
});
