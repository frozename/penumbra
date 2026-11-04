import { describe, expect, test } from "bun:test";

import {
  assessWorkerCodeStaleness,
  resolveWorkerCodeSha,
  resolveWorkerCodeShaAsync,
  shouldCheckWorkerCodeStaleness,
  WORKER_CODE_STALENESS_CHECK_INTERVAL_MS,
} from "@src/worker/code-staleness.js";

const INVALID_SHA_RESULT = {
  status: "unknown",
  sha: null,
  reason: "git returned an invalid HEAD sha",
} as const;

describe("worker code sha validation rules", () => {
  test("rejects a hex sha shorter than 40 characters on the sync path", () => {
    const resolved = resolveWorkerCodeSha("/repo", {
      execFileSync: () => "a".repeat(39),
    });

    expect(resolved).toEqual(INVALID_SHA_RESULT);
  });

  test("rejects a hex sha longer than 64 characters on the sync path", () => {
    const resolved = resolveWorkerCodeSha("/repo", {
      execFileSync: () => "a".repeat(65),
    });

    expect(resolved).toEqual(INVALID_SHA_RESULT);
  });

  test("rejects a 40-character string that is not hex on the sync path", () => {
    const resolved = resolveWorkerCodeSha("/repo", {
      execFileSync: () => "g".repeat(40),
    });

    expect(resolved).toEqual(INVALID_SHA_RESULT);
  });

  test("accepts a 64-character sha256-length hex sha, pinning the inclusive upper bound", () => {
    const resolved = resolveWorkerCodeSha("/repo", {
      execFileSync: () => "b".repeat(64),
    });

    expect(resolved).toEqual({ status: "resolved", sha: "b".repeat(64) });
  });

  test("trims surrounding whitespace and newlines from the sync sha output", () => {
    const resolved = resolveWorkerCodeSha("/repo", {
      execFileSync: () => `  ${"c".repeat(40)}\n`,
    });

    expect(resolved).toEqual({ status: "resolved", sha: "c".repeat(40) });
  });

  test("maps invalid async stdout to the invalid-sha reason", async () => {
    const resolved = await resolveWorkerCodeShaAsync("/repo", {
      execFile: (_file, _args, _options, callback): void => {
        callback(null, "not-a-sha\n", "");
      },
    });

    expect(resolved).toEqual(INVALID_SHA_RESULT);
  });

  test("prefers the async error over valid stdout and strips credentials from its reason", async () => {
    const resolved = await resolveWorkerCodeShaAsync("/repo", {
      execFile: (_file, _args, _options, callback): void => {
        callback(
          new Error("fatal: https://bot:secret@example.com/o/r.git unreachable"),
          "d".repeat(40),
          "",
        );
      },
    });

    expect(resolved).toEqual({
      status: "unknown",
      sha: null,
      reason: "fatal: https://example.com/o/r.git unreachable",
    });
  });

  test("formats a thrown non-Error string as its own reason", () => {
    const thrown: unknown = "boom";
    const resolved = resolveWorkerCodeSha("/repo", {
      execFileSync: (): never => {
        throw thrown;
      },
    });

    expect(resolved).toEqual({ status: "unknown", sha: null, reason: "boom" });
  });

  test("maps an empty thrown non-Error value to the unknown error reason", () => {
    const thrown: unknown = "";
    const resolved = resolveWorkerCodeSha("/repo", {
      execFileSync: (): never => {
        throw thrown;
      },
    });

    expect(resolved).toEqual({ status: "unknown", sha: null, reason: "unknown error" });
  });

  test("strips credentials from a thrown non-Error ssh url reason", () => {
    const thrown: unknown = "ssh://git:pw@host.example/repo";
    const resolved = resolveWorkerCodeSha("/repo", {
      execFileSync: (): never => {
        throw thrown;
      },
    });

    expect(resolved).toEqual({ status: "unknown", sha: null, reason: "ssh://host.example/repo" });
  });

  test("invokes git rev-parse HEAD against the repo root with piped stdio on the sync path", () => {
    const calls: { file: string; args: readonly string[]; stdio: unknown }[] = [];
    const resolved = resolveWorkerCodeSha("/some/root", {
      execFileSync: (file, args, options): string => {
        calls.push({ file, args, stdio: options.stdio });
        return "e".repeat(40);
      },
    });

    expect(resolved).toEqual({ status: "resolved", sha: "e".repeat(40) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("git");
    expect(calls[0]?.args).toEqual(["-C", "/some/root", "rev-parse", "HEAD"]);
    expect(calls[0]?.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  test("invokes git rev-parse HEAD against the repo root on the async path", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const resolved = await resolveWorkerCodeShaAsync("/some/root", {
      execFile: (file, args, _options, callback): void => {
        calls.push({ file, args });
        callback(null, "e".repeat(40), "");
      },
    });

    expect(resolved).toEqual({ status: "resolved", sha: "e".repeat(40) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("git");
    expect(calls[0]?.args).toEqual(["-C", "/some/root", "rev-parse", "HEAD"]);
  });
});

describe("worker code staleness assessment rules", () => {
  test("compares shas case-insensitively", () => {
    expect(
      assessWorkerCodeStaleness({
        bootSha: "A".repeat(40),
        currentSha: "a".repeat(40),
      }),
    ).toEqual({ status: "current", stale: false });
  });

  test("compares shas after trimming whitespace", () => {
    expect(
      assessWorkerCodeStaleness({
        bootSha: `${"a".repeat(40)}\n`,
        currentSha: "a".repeat(40),
      }),
    ).toEqual({ status: "current", stale: false });
  });

  test("reports unknown, not stale, when the boot sha is invalid even if the current sha is valid", () => {
    expect(
      assessWorkerCodeStaleness({
        bootSha: "a".repeat(39),
        currentSha: "b".repeat(40),
      }),
    ).toEqual({ status: "unknown", stale: false });
  });

  test("reports unknown when the current sha is undefined despite a valid boot sha", () => {
    expect(
      assessWorkerCodeStaleness({
        bootSha: "a".repeat(40),
        currentSha: undefined,
      }),
    ).toEqual({ status: "unknown", stale: false });
  });
});

describe("worker code staleness default interval", () => {
  test("throttles to the exported default interval when intervalMs is omitted", () => {
    const lastCheckedAtMs = 1_000;

    expect(
      shouldCheckWorkerCodeStaleness({
        lastCheckedAtMs,
        nowMs: lastCheckedAtMs + WORKER_CODE_STALENESS_CHECK_INTERVAL_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldCheckWorkerCodeStaleness({
        lastCheckedAtMs,
        nowMs: lastCheckedAtMs + WORKER_CODE_STALENESS_CHECK_INTERVAL_MS,
      }),
    ).toBe(true);
  });
});
