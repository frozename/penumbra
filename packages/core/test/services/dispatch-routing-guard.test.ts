import { describe, expect, test } from "bun:test";

import type { ResolvedProjectEntry } from "@src/projects/schema.js";
import {
  collectMentionedPaths,
  inspectPromptVsProject,
  resolveProjectIdFromAbsolutePath,
} from "@src/services/dispatch-routing-guard.js";

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

test("same-project absolute paths are ok", () => {
  const result = inspectPromptVsProject({
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

test("cross-project absolute paths suggest the matching project", () => {
  const result = inspectPromptVsProject({
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

test("packages references can suggest another project when missing in the resolved project", () => {
  const existsSync = (path: string): boolean =>
    path === "/Volumes/WorkSSD/repos/personal/llamactl/packages/train";
  const result = inspectPromptVsProject(
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

test("packages references memoize existsSync lookups within one guard call", () => {
  const seen = new Map<string, number>();
  const existsSync = (path: string): boolean => {
    seen.set(path, (seen.get(path) ?? 0) + 1);
    return path === "/Volumes/WorkSSD/repos/personal/llamactl/packages/train";
  };
  const result = inspectPromptVsProject(
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

test("no paths mentioned is ok", () => {
  const result = inspectPromptVsProject({
    prompt: "refactor the parser to be order-independent",
    project_id: "penumbra",
    registry,
  });

  expect(result).toEqual({
    status: "ok",
    mentioned_paths: [],
  });
});

test("mentions from multiple projects are ambiguous", () => {
  const result = inspectPromptVsProject({
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

test("ambiguous absolute mentions trigger mismatch without a suggestion", () => {
  const result = inspectPromptVsProject({
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

test("suggested project prefers the most frequently mentioned alternate project", () => {
  const result = inspectPromptVsProject({
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

test("canonical path mentions suggest the aliased project", () => {
  const result = inspectPromptVsProject({
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

test("alias path mentions suggest the canonical-backed project", () => {
  const result = inspectPromptVsProject({
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

test("literal-only registry behavior is unchanged without canonical roots", () => {
  const result = inspectPromptVsProject({
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
