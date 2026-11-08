import { describe, expect, test } from "bun:test";

import { parseUpdateArgs } from "@src/commands/update/options.js";

const SHA_7 = "abc1234";
const SHA_40 = "a".repeat(40);

describe("parseUpdateArgs argument rules", () => {
  describe("modes and rollback sha", () => {
    test("no mode flag defaults to check", () => {
      expect(parseUpdateArgs([], {}, "/repo")).toMatchObject({
        ok: true,
        options: { mode: "check" },
      });
    });

    test("--apply selects the apply mode", () => {
      expect(parseUpdateArgs(["--apply"], {}, "/repo")).toMatchObject({
        ok: true,
        options: { mode: "apply", rollbackSha: null },
      });
    });

    test("--rollback alone leaves rollbackSha null", () => {
      expect(parseUpdateArgs(["--rollback"], {}, "/repo")).toMatchObject({
        ok: true,
        options: { mode: "rollback", rollbackSha: null },
      });
    });

    test("--rollback consumes a 7-character hex sha", () => {
      expect(parseUpdateArgs(["--rollback", SHA_7], {}, "/repo")).toMatchObject({
        ok: true,
        options: { mode: "rollback", rollbackSha: SHA_7 },
      });
    });

    test("--rollback consumes a 40-character hex sha", () => {
      expect(parseUpdateArgs(["--rollback", SHA_40], {}, "/repo")).toMatchObject({
        ok: true,
        options: { mode: "rollback", rollbackSha: SHA_40 },
      });
    });

    test("--rollback does not consume a non-hex argument and it fails as unknown", () => {
      expect(parseUpdateArgs(["--rollback", "main"], {}, "/repo")).toEqual({
        ok: false,
        error: "unknown argument: main",
      });
    });

    test("--rollback does not consume an uppercase hex sha", () => {
      expect(parseUpdateArgs(["--rollback", "ABCDEF1"], {}, "/repo")).toEqual({
        ok: false,
        error: "unknown argument: ABCDEF1",
      });
    });

    test("--check and --apply are exclusive", () => {
      expect(parseUpdateArgs(["--check", "--apply"], {}, "/repo")).toEqual({
        ok: false,
        error: "--check, --apply and --rollback are exclusive",
      });
    });

    test("--apply and --rollback with a sha are still exclusive", () => {
      expect(parseUpdateArgs(["--apply", "--rollback", SHA_7], {}, "/repo")).toEqual({
        ok: false,
        error: "--check, --apply and --rollback are exclusive",
      });
    });

    test("--help short-circuits before any other parsing", () => {
      expect(parseUpdateArgs(["--apply", "--help"], {}, "/repo")).toEqual({ ok: "help" });
    });
  });

  describe("value flags", () => {
    test("an unrecognized flag is an unknown argument", () => {
      expect(parseUpdateArgs(["--nope"], {}, "/repo")).toEqual({
        ok: false,
        error: "unknown argument: --nope",
      });
    });

    test("a value flag at the end of the list requires a value", () => {
      expect(parseUpdateArgs(["--ref"], {}, "/repo")).toEqual({
        ok: false,
        error: "--ref requires a value",
      });
    });

    test("a value flag followed by another flag requires a value", () => {
      expect(parseUpdateArgs(["--ref", "--apply"], {}, "/repo")).toEqual({
        ok: false,
        error: "--ref requires a value",
      });
    });

    test("--ref sets the target ref", () => {
      expect(parseUpdateArgs(["--ref", "upstream/dev"], {}, "/repo")).toMatchObject({
        ok: true,
        options: { ref: "upstream/dev" },
      });
    });

    test("--allow-red-ci and --json are boolean flags", () => {
      expect(parseUpdateArgs(["--allow-red-ci", "--json"], {}, "/repo")).toMatchObject({
        ok: true,
        options: { allowRedCi: true, json: true },
      });
    });

    test("--repo keeps an absolute path as-is", () => {
      expect(parseUpdateArgs(["--repo", "/abs/pen"], {}, "/cwd")).toMatchObject({
        ok: true,
        options: { repo: "/abs/pen" },
      });
    });

    test("--repo resolves a relative path against cwd", () => {
      expect(parseUpdateArgs(["--repo", "../pen"], {}, "/home/op/x")).toMatchObject({
        ok: true,
        options: { repo: "/home/op/pen" },
      });
    });
  });

  describe("seconds flags", () => {
    test("--wait-idle accepts zero", () => {
      expect(parseUpdateArgs(["--wait-idle", "0"], {}, "/repo")).toMatchObject({
        ok: true,
        options: { waitIdleS: 0 },
      });
    });

    test("--wait-idle rejects a negative integer", () => {
      expect(parseUpdateArgs(["--wait-idle", "-1"], {}, "/repo")).toEqual({
        ok: false,
        error: "--wait-idle must be a non-negative integer (got -1)",
      });
    });

    test("--wait-idle rejects a fractional value", () => {
      expect(parseUpdateArgs(["--wait-idle", "1.5"], {}, "/repo")).toEqual({
        ok: false,
        error: "--wait-idle must be a non-negative integer (got 1.5)",
      });
    });

    test("--wait-idle rejects a non-numeric value and echoes it", () => {
      expect(parseUpdateArgs(["--wait-idle", "abc"], {}, "/repo")).toEqual({
        ok: false,
        error: "--wait-idle must be a non-negative integer (got abc)",
      });
    });

    test("--verify-timeout accepts an explicit value", () => {
      expect(parseUpdateArgs(["--verify-timeout", "45"], {}, "/repo")).toMatchObject({
        ok: true,
        options: { verifyTimeoutS: 45 },
      });
    });
  });

  describe("environment precedence", () => {
    test("an empty environment yields the documented defaults", () => {
      expect(parseUpdateArgs([], {}, "/repo")).toEqual({
        ok: true,
        options: {
          mode: "check",
          ref: "origin/main",
          rollbackSha: null,
          allowRedCi: false,
          waitIdleS: 900,
          verifyTimeoutS: 120,
          json: false,
          repo: null,
          serviceManager: "auto",
          daemonUnit: "penumbra-daemon.service",
          workerUnit: "penumbra-worker.service",
          daemonLabel: "dev.penumbra.daemon",
          workerLabel: "dev.penumbra.worker",
        },
      });
    });

    test("PENUMBRA_UPDATE_DAEMON_UNIT supplies the daemon unit default", () => {
      expect(
        parseUpdateArgs([], { PENUMBRA_UPDATE_DAEMON_UNIT: "pd.service" }, "/repo"),
      ).toMatchObject({ ok: true, options: { daemonUnit: "pd.service" } });
    });

    test("--service-manager overrides PENUMBRA_UPDATE_SERVICE_MANAGER", () => {
      expect(
        parseUpdateArgs(
          ["--service-manager", "systemd"],
          { PENUMBRA_UPDATE_SERVICE_MANAGER: "launchd" },
          "/repo",
        ),
      ).toMatchObject({ ok: true, options: { serviceManager: "systemd" } });
    });

    test("an invalid PENUMBRA_UPDATE_* value fails as an invalid setting", () => {
      const parsed = parseUpdateArgs([], { PENUMBRA_UPDATE_SERVICE_MANAGER: "runit" }, "/repo");
      const failed = parsed as { ok: false; error: string };
      expect(failed.ok).toBe(false);
      expect(failed.error.startsWith("invalid PENUMBRA_UPDATE_* setting: ")).toBe(true);
    });
  });

  describe("unit and label names", () => {
    test("a daemon unit without the .service suffix is rejected", () => {
      expect(parseUpdateArgs(["--daemon-unit", "foo"], {}, "/repo")).toEqual({
        ok: false,
        error: "not a systemd service unit: foo",
      });
    });

    test("a launchd label with a slash is rejected", () => {
      expect(parseUpdateArgs(["--daemon-label", "dev/daemon"], {}, "/repo")).toEqual({
        ok: false,
        error: "not a launchd label: dev/daemon",
      });
    });
  });
});
