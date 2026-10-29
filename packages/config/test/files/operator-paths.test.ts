import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  resolveLegacyOperatorConfigPath,
  resolveOperatorConfigPath,
} from "@src/files/operator-paths.js";

// #342: pin the operator config path precedence. Every case passes an explicit env
// object; none reads or changes process.env. The os.homedir() fallback cases compare
// against homedir() computed in this process, so they hold on any host.
describe("resolveOperatorConfigPath", () => {
  test("PENUMBRA_PROJECTS_YAML wins over PENUMBRA_CONFIG_DIR and HOME for projects.yaml", () => {
    const env = { PENUMBRA_PROJECTS_YAML: "/x/p.yaml", PENUMBRA_CONFIG_DIR: "/cfg", HOME: "/h" };
    expect(resolveOperatorConfigPath("projects.yaml", env)).toBe("/x/p.yaml");
  });

  test("PENUMBRA_WORKERS_CONFIG_PATH wins over PENUMBRA_CONFIG_DIR and HOME for workers.yaml", () => {
    const env = {
      PENUMBRA_WORKERS_CONFIG_PATH: "/w/workers.yaml",
      PENUMBRA_CONFIG_DIR: "/cfg",
      HOME: "/h",
    };
    expect(resolveOperatorConfigPath("workers.yaml", env)).toBe("/w/workers.yaml");
  });

  test("an override is returned exactly as given, not joined with any directory", () => {
    const env = { PENUMBRA_PROJECTS_YAML: "rel/p.yaml", PENUMBRA_CONFIG_DIR: "/cfg", HOME: "/h" };
    expect(resolveOperatorConfigPath("projects.yaml", env)).toBe("rel/p.yaml");
  });

  test("each override applies only to its own file", () => {
    expect(
      resolveOperatorConfigPath("workers.yaml", {
        PENUMBRA_PROJECTS_YAML: "/x/p.yaml",
        PENUMBRA_CONFIG_DIR: "/cfg",
      }),
    ).toBe("/cfg/workers.yaml");
    expect(
      resolveOperatorConfigPath("projects.yaml", {
        PENUMBRA_WORKERS_CONFIG_PATH: "/w/workers.yaml",
        PENUMBRA_CONFIG_DIR: "/cfg",
      }),
    ).toBe("/cfg/projects.yaml");
  });

  test("a filename with no override key ignores both override variables", () => {
    const env = {
      PENUMBRA_PROJECTS_YAML: "/x/p.yaml",
      PENUMBRA_WORKERS_CONFIG_PATH: "/w/workers.yaml",
      PENUMBRA_CONFIG_DIR: "/cfg",
    };
    expect(resolveOperatorConfigPath("agents.yaml", env)).toBe("/cfg/agents.yaml");
  });

  test("an empty override string falls through to PENUMBRA_CONFIG_DIR", () => {
    expect(
      resolveOperatorConfigPath("projects.yaml", {
        PENUMBRA_PROJECTS_YAML: "",
        PENUMBRA_CONFIG_DIR: "/cfg",
      }),
    ).toBe("/cfg/projects.yaml");
    expect(
      resolveOperatorConfigPath("workers.yaml", {
        PENUMBRA_WORKERS_CONFIG_PATH: "",
        PENUMBRA_CONFIG_DIR: "/cfg",
      }),
    ).toBe("/cfg/workers.yaml");
  });

  test("with PENUMBRA_CONFIG_DIR unset or empty the base is HOME/.config/penumbra", () => {
    expect(resolveOperatorConfigPath("projects.yaml", { HOME: "/h" })).toBe(
      "/h/.config/penumbra/projects.yaml",
    );
    expect(
      resolveOperatorConfigPath("projects.yaml", { PENUMBRA_CONFIG_DIR: "", HOME: "/h" }),
    ).toBe("/h/.config/penumbra/projects.yaml");
  });

  test("with HOME unset or empty the base is os.homedir()/.config/penumbra", () => {
    const expected = join(homedir(), ".config/penumbra", "projects.yaml");
    expect(resolveOperatorConfigPath("projects.yaml", {})).toBe(expected);
    expect(resolveOperatorConfigPath("projects.yaml", { HOME: "" })).toBe(expected);
  });

  test("a trailing slash on PENUMBRA_CONFIG_DIR is normalized by join", () => {
    expect(resolveOperatorConfigPath("projects.yaml", { PENUMBRA_CONFIG_DIR: "/cfg/" })).toBe(
      "/cfg/projects.yaml",
    );
  });
});

describe("resolveLegacyOperatorConfigPath", () => {
  test("uses HOME/.penumbra and ignores PENUMBRA_CONFIG_DIR and the file override", () => {
    expect(
      resolveLegacyOperatorConfigPath("projects.yaml", {
        HOME: "/h",
        PENUMBRA_CONFIG_DIR: "/cfg",
        PENUMBRA_PROJECTS_YAML: "/x/p.yaml",
      }),
    ).toBe("/h/.penumbra/projects.yaml");
    expect(
      resolveLegacyOperatorConfigPath("workers.yaml", {
        HOME: "/h",
        PENUMBRA_WORKERS_CONFIG_PATH: "/w/workers.yaml",
      }),
    ).toBe("/h/.penumbra/workers.yaml");
  });

  test("falls back to os.homedir()/.penumbra when HOME is unset or empty", () => {
    const expected = join(homedir(), ".penumbra", "projects.yaml");
    expect(resolveLegacyOperatorConfigPath("projects.yaml", {})).toBe(expected);
    expect(resolveLegacyOperatorConfigPath("projects.yaml", { HOME: "" })).toBe(expected);
  });
});
