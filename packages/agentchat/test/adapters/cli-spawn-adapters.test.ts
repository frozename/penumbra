import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCliSpawnOpts,
  buildOpencodeCliSpawnOpts,
  makeCliSpawnAdapter,
} from "@src/adapters/cli-spawn-adapters.js";
import type { DispatchInput } from "@src/sdk/adapter.js";

import { expectRejection } from "../helpers/cli-spawn-fixtures.js";

function makeInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    prompt: "x",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("worker cli-spawn adapter spawn opts", () => {
  test("buildCliSpawnOpts forwards permission_profile and sandbox_deny_roots", () => {
    const opts = buildCliSpawnOpts(
      "claude-cli",
      { command: "claude" },
      ["code", "--no-tty"],
      "claude",
      null,
      makeInput({
        permission_profile: "review_readonly",
        sandbox_deny_roots: ["/caller/root", "/project/root"],
      }),
    );
    expect(opts.permission_profile).toBe("review_readonly");
    expect(opts.sandbox_deny_roots).toEqual(["/caller/root", "/project/root"]);
  });

  test("buildOpencodeCliSpawnOpts forwards permission_profile and sandbox_deny_roots", async () => {
    const opts = await buildOpencodeCliSpawnOpts(
      { model: "gpt-5" },
      "opencode",
      ["run"],
      null,
      makeInput({
        permission_profile: "review_readonly",
        sandbox_deny_roots: ["/caller/root"],
      }),
    );
    expect(opts.permission_profile).toBe("review_readonly");
    expect(opts.sandbox_deny_roots).toEqual(["/caller/root"]);
  });

  test.skipIf(process.platform === "darwin")(
    "makeCliSpawnAdapter dispatch fails closed on a profile without sandbox-exec",
    async () => {
      const adapter = makeCliSpawnAdapter("claude-cli", { command: "cat" }, [], (t) => t, null);
      await expectRejection(
        adapter.dispatch(makeInput({ permission_profile: "review_readonly" })),
        /sandbox-exec unavailable/,
      );
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "makeCliSpawnAdapter profile dispatch denies writes under cwd and deny roots",
    async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "penumbra-wcli-cwd-")));
      const callerRoot = realpathSync(mkdtempSync(join(tmpdir(), "penumbra-wcli-caller-")));
      try {
        const adapter = makeCliSpawnAdapter(
          "claude-cli",
          {
            command: "sh",
            args: ["-c", 'touch "$1" "$2"', "--", join(cwd, "a.txt"), join(callerRoot, "b.txt")],
            cwd,
          },
          [],
          (t) => t,
          null,
        );
        await expectRejection(
          adapter.dispatch(
            makeInput({
              permission_profile: "review_readonly",
              sandbox_deny_roots: [callerRoot],
            }),
          ),
          /exit code/,
        );
        expect(existsSync(join(cwd, "a.txt"))).toBe(false);
        expect(existsSync(join(callerRoot, "b.txt"))).toBe(false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(callerRoot, { recursive: true, force: true });
      }
    },
  );
});
