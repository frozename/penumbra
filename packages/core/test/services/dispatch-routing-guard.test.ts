import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import type { ResolvedProjectEntry } from "@src/projects/schema.js";
import {
  collectMentionedPaths,
  inspectPromptVsProject,
  resolveProjectIdFromAbsolutePath,
} from "@src/services/dispatch-routing-guard.js";

const execFile = promisify(execFileCb);

const registry: ResolvedProjectEntry[] = [
  {
    project_id: "penumbra",
    root_path: "/Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be",
  },
  {
    project_id: "llamactl",
    root_path: "/Volumes/WorkSSD/repos/personal/llamactl",
  },
];

const aliasRegistry: ResolvedProjectEntry[] = [
  {
    project_id: "penumbra",
    root_path: "/Users/me/alias/penumbra",
    canonical_root_path: "/Volumes/canon/penumbra",
  },
  {
    project_id: "other",
    root_path: "/Users/me/alias/other",
  },
];

const nestedRegistry: ResolvedProjectEntry[] = [
  {
    project_id: "outer",
    root_path: "/tmp/projects",
  },
  {
    project_id: "inner",
    root_path: "/tmp/projects/inner",
  },
];

describe("collectMentionedPaths", () => {
  test("empty prompt returns no paths", () => {
    expect(collectMentionedPaths("", registry)).toEqual([]);
  });

  test("prompt with no paths returns no paths", () => {
    expect(collectMentionedPaths("refactor the parser to be order-independent", registry)).toEqual(
      [],
    );
  });

  test("absolute path under a registered root_path is returned", () => {
    expect(
      collectMentionedPaths("touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts", registry),
    ).toEqual(["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts"]);
  });

  test("absolute path outside the registry is dropped", () => {
    expect(
      collectMentionedPaths("touch /Volumes/WorkSSD/repos/personal/unknown/src/foo.ts", registry),
    ).toEqual([]);
  });

  test("packages mentions are deduped", () => {
    expect(
      collectMentionedPaths(
        "work in packages/train with packages/train and packages/train",
        registry,
      ),
    ).toEqual(["packages/train"]);
  });

  test("absolute and packages mentions are both returned", () => {
    expect(
      collectMentionedPaths(
        "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts and update packages/train",
        registry,
      ),
    ).toEqual(["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts", "packages/train"]);
  });
});

describe("resolveProjectIdFromAbsolutePath", () => {
  test("exact root_path resolves to the project_id", () => {
    expect(
      resolveProjectIdFromAbsolutePath("/Volumes/WorkSSD/repos/personal/llamactl", registry),
    ).toEqual({
      status: "unique",
      project_id: "llamactl",
    });
  });

  test("path with trailing segments resolves to the project_id", () => {
    expect(
      resolveProjectIdFromAbsolutePath(
        "/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
        registry,
      ),
    ).toEqual({
      status: "unique",
      project_id: "llamactl",
    });
  });

  test("unknown path returns none", () => {
    expect(
      resolveProjectIdFromAbsolutePath(
        "/Volumes/WorkSSD/repos/personal/unknown/src/foo.ts",
        registry,
      ),
    ).toEqual({ status: "none" });
  });

  test("shared prefixes without a path separator do not match", () => {
    expect(
      resolveProjectIdFromAbsolutePath(
        "/Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be-extra/foo.ts",
        registry,
      ),
    ).toEqual({
      status: "none",
    });
  });

  test("nested roots resolve to the longest matching prefix", () => {
    expect(
      resolveProjectIdFromAbsolutePath("/tmp/projects/inner/src/foo.ts", nestedRegistry),
    ).toEqual({
      status: "unique",
      project_id: "inner",
    });
  });

  test("equal-length matching roots with different projects are ambiguous", () => {
    expect(
      resolveProjectIdFromAbsolutePath("/tmp/projects/shared/src/foo.ts", [
        { project_id: "alpha", root_path: "/tmp/projects/shared" },
        { project_id: "beta", root_path: "/tmp/projects/shared" },
      ]),
    ).toEqual({ status: "ambiguous" });
  });
});

test("same-project absolute paths are ok", async () => {
  const result = await inspectPromptVsProject({
    prompt:
      "touch /Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be/packages/core/src/index.ts",
    project_id: "penumbra",
    registry,
  });

  expect(result).toEqual({
    status: "ok",
    mentioned_paths: [
      "/Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be/packages/core/src/index.ts",
    ],
  });
});

test("cross-project absolute paths suggest the matching project", async () => {
  const result = await inspectPromptVsProject({
    prompt: "inspect /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
    project_id: "penumbra",
    registry,
  });

  expect(result).toEqual({
    status: "mismatch",
    mentioned_paths: ["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts"],
    missing_in_project: [],
    suggested_project_id: "llamactl",
  });
});

test("packages references can suggest another project when missing in the resolved project", async () => {
  const existsSync = (path: string): boolean =>
    path === "/Volumes/WorkSSD/repos/personal/llamactl/packages/train";
  const result = await inspectPromptVsProject(
    {
      prompt: "work in packages/train and update the pipeline",
      project_id: "penumbra",
      registry,
    },
    { existsSync },
  );

  expect(result).toEqual({
    status: "mismatch",
    mentioned_paths: ["packages/train"],
    missing_in_project: ["packages/train"],
    suggested_project_id: "llamactl",
  });
});

test("packages references memoize existsSync lookups within one guard call", async () => {
  const seen = new Map<string, number>();
  const existsSync = (path: string): boolean => {
    seen.set(path, (seen.get(path) ?? 0) + 1);
    return path === "/Volumes/WorkSSD/repos/personal/llamactl/packages/train";
  };
  const result = await inspectPromptVsProject(
    {
      prompt: "work in packages/train with packages/train and packages/train",
      project_id: "penumbra",
      registry,
    },
    { existsSync },
  );

  expect(result.status).toBe("mismatch");
  expect(
    seen.get(
      "/Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be/packages/train",
    ),
  ).toBe(1);
  expect(seen.get("/Volumes/WorkSSD/repos/personal/llamactl/packages/train")).toBe(1);
});

test("no paths mentioned is ok", async () => {
  const result = await inspectPromptVsProject({
    prompt: "refactor the parser to be order-independent",
    project_id: "penumbra",
    registry,
  });

  expect(result).toEqual({
    status: "ok",
    mentioned_paths: [],
  });
});

test("mentions from multiple projects are ambiguous", async () => {
  const result = await inspectPromptVsProject({
    prompt: [
      "compare /Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be/packages/core/src/index.ts",
      "with /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
    ].join(" "),
    project_id: "penumbra",
    registry,
  });

  expect(result).toEqual({
    status: "mismatch",
    mentioned_paths: [
      "/Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be/packages/core/src/index.ts",
      "/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
    ],
    missing_in_project: [],
  });
});

test("ambiguous absolute mentions trigger mismatch without a suggestion", async () => {
  const result = await inspectPromptVsProject({
    prompt: "inspect /tmp/projects/shared/src/foo.ts",
    project_id: "penumbra",
    registry: [
      { project_id: "alpha", root_path: "/tmp/projects/shared" },
      { project_id: "beta", root_path: "/tmp/projects/shared" },
      ...registry,
    ],
  });

  expect(result).toEqual({
    status: "mismatch",
    mentioned_paths: ["/tmp/projects/shared/src/foo.ts"],
    missing_in_project: [],
  });
});

test("suggested project prefers the most frequently mentioned alternate project", async () => {
  const result = await inspectPromptVsProject({
    prompt: [
      "/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      "/Volumes/WorkSSD/repos/personal/llamactl/src/bar.ts",
    ].join(" "),
    project_id: "penumbra",
    registry,
  });

  expect(result).toEqual({
    status: "mismatch",
    mentioned_paths: [
      "/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      "/Volumes/WorkSSD/repos/personal/llamactl/src/bar.ts",
    ],
    missing_in_project: [],
    suggested_project_id: "llamactl",
  });
});

test("canonical path mentions suggest the aliased project", async () => {
  const result = await inspectPromptVsProject({
    prompt: "inspect /Volumes/canon/penumbra/src/foo.ts",
    project_id: "other",
    registry: aliasRegistry,
  });

  expect(result).toEqual({
    status: "mismatch",
    mentioned_paths: ["/Volumes/canon/penumbra/src/foo.ts"],
    missing_in_project: [],
    suggested_project_id: "penumbra",
  });
});

test("alias path mentions suggest the canonical-backed project", async () => {
  const result = await inspectPromptVsProject({
    prompt: "inspect /Users/me/alias/penumbra/src/foo.ts",
    project_id: "other",
    registry: aliasRegistry,
  });

  expect(result).toEqual({
    status: "mismatch",
    mentioned_paths: ["/Users/me/alias/penumbra/src/foo.ts"],
    missing_in_project: [],
    suggested_project_id: "penumbra",
  });
});

test("literal-only registry behavior is unchanged without canonical roots", async () => {
  const result = await inspectPromptVsProject({
    prompt: "inspect /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
    project_id: "penumbra",
    registry,
  });

  expect(result).toEqual({
    status: "mismatch",
    mentioned_paths: ["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts"],
    missing_in_project: [],
    suggested_project_id: "llamactl",
  });
});

describe("package tokens resolved against the target project's git", () => {
  const temps: string[] = [];
  let targetRepo: string;
  let otherRoot: string;
  let branchBaseOnlySha: string;
  let gitRegistry: ResolvedProjectEntry[];

  async function git(repoDir: string, args: string[]): Promise<string> {
    const { stdout } = await execFile("git", ["-C", repoDir, ...args], { encoding: "utf8" });
    return stdout.trim();
  }

  function writePackage(root: string, name: string): void {
    fs.mkdirSync(path.join(root, "packages", name), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", name, "package.json"), `{"name":"${name}"}\n`);
  }

  async function commitAll(repoDir: string, message: string): Promise<void> {
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-q", "-m", message]);
  }

  beforeAll(async () => {
    targetRepo = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-routing-guard-target-"));
    otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-routing-guard-other-"));
    temps.push(targetRepo, otherRoot);
    await git(targetRepo, ["init", "-q", "-b", "main"]);
    await git(targetRepo, ["config", "user.email", "test@example.com"]);
    await git(targetRepo, ["config", "user.name", "test"]);
    writePackage(targetRepo, "core");
    await commitAll(targetRepo, "init");

    writePackage(targetRepo, "exec-primitives");
    await commitAll(targetRepo, "add exec-primitives");
    fs.rmSync(path.join(targetRepo, "packages", "exec-primitives"), { recursive: true });
    await commitAll(targetRepo, "retire exec-primitives");

    await git(targetRepo, ["checkout", "-q", "-b", "ahead"]);
    writePackage(targetRepo, "fresh");
    await commitAll(targetRepo, "add fresh");
    branchBaseOnlySha = await git(targetRepo, ["rev-parse", "HEAD"]);
    await git(targetRepo, ["checkout", "-q", "main"]);
    await git(targetRepo, ["branch", "-q", "-D", "ahead"]);

    for (const name of ["exec-primitives", "fresh", "train"]) writePackage(otherRoot, name);
    gitRegistry = [
      { project_id: "penumbra", root_path: targetRepo },
      { project_id: "nova", root_path: otherRoot },
    ];
  });

  afterAll(() => {
    for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
  });

  test("a package present only at branch_base belongs to the target project", async () => {
    const input = {
      prompt: "extend packages/fresh with the new probe",
      project_id: "penumbra",
      registry: gitRegistry,
    };

    expect(await inspectPromptVsProject({ ...input, branch_base: branchBaseOnlySha })).toEqual({
      status: "ok",
      mentioned_paths: ["packages/fresh"],
    });
    expect(await inspectPromptVsProject(input)).toEqual({
      status: "mismatch",
      mentioned_paths: ["packages/fresh"],
      missing_in_project: ["packages/fresh"],
      suggested_project_id: "nova",
    });
  });

  test("a package deleted from the target's tree still belongs to it through history", async () => {
    const result = await inspectPromptVsProject({
      prompt: "confirm `bun test packages/exec-primitives/test` no longer resolves",
      project_id: "penumbra",
      registry: gitRegistry,
    });

    expect(result).toEqual({ status: "ok", mentioned_paths: ["packages/exec-primitives"] });
  });

  test("a package the target never had still suggests the project that holds it", async () => {
    const result = await inspectPromptVsProject({
      prompt: "work in packages/train",
      project_id: "penumbra",
      branch_base: "main",
      registry: gitRegistry,
    });

    expect(result).toEqual({
      status: "mismatch",
      mentioned_paths: ["packages/train"],
      missing_in_project: ["packages/train"],
      suggested_project_id: "nova",
    });
  });
});
