import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { materializeWorkspaceLinks } from "@src/worktree/manager.js";

function workspaceFixture(rootManifest: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-declared-links-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"], ...rootManifest }),
  );
  for (const name of ["core", "daemon", "agentchat"]) {
    const dir = path.join(root, "packages", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: `@penumbra/${name}`, exports: { ".": "./index.js" } }),
    );
    fs.writeFileSync(path.join(dir, "index.js"), "export const value = 1;\n");
  }
  return root;
}

for (const [field, spec] of [
  ["dependencies", "workspace:^"],
  ["devDependencies", "workspace:*"],
  ["optionalDependencies", "workspace:~"],
] as const) {
  test(`workspace links include only root ${field} declarations with ${spec}`, () => {
    const root = workspaceFixture({ [field]: { "@penumbra/core": spec } });
    try {
      materializeWorkspaceLinks(root);

      const scope = path.join(root, "node_modules", "@penumbra");
      expect(fs.readdirSync(scope)).toEqual(["core"]);
      const link = path.join(scope, "core");
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(path.isAbsolute(fs.readlinkSync(link))).toBe(false);
      expect(fs.realpathSync.native(link)).toBe(
        fs.realpathSync.native(path.join(root, "packages", "core")),
      );
      const requireFromAgentchat = createRequire(
        path.join(root, "packages", "agentchat", "index.js"),
      );
      expect(() => requireFromAgentchat.resolve("@penumbra/daemon")).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("workspace links exclude non-workspace specs and peer-only declarations", () => {
  const root = workspaceFixture({
    dependencies: { "@penumbra/core": "*" },
    devDependencies: { "@penumbra/agentchat": null },
    peerDependencies: { "@penumbra/daemon": "workspace:*" },
  });
  try {
    materializeWorkspaceLinks(root);

    expect(fs.readdirSync(path.join(root, "node_modules", "@penumbra"))).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace links keep a workspace declaration when another dependency section has a different spec", () => {
  const root = workspaceFixture({
    dependencies: { "@penumbra/core": "workspace:*" },
    devDependencies: { "@penumbra/core": "*" },
  });
  try {
    materializeWorkspaceLinks(root);

    expect(fs.readdirSync(path.join(root, "node_modules", "@penumbra"))).toEqual(["core"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace links leave undeclared entries exactly as the install left them", () => {
  const root = workspaceFixture({ devDependencies: { "@penumbra/core": "workspace:*" } });
  try {
    const scope = path.join(root, "node_modules", "@penumbra");
    fs.mkdirSync(scope, { recursive: true });
    const link = path.join(scope, "daemon");
    fs.symlinkSync("../../packages/daemon", link, "dir");
    const before = fs.lstatSync(link);
    const sentinel = path.join(scope, "agentchat", "sentinel.txt");
    fs.mkdirSync(path.dirname(sentinel));
    fs.writeFileSync(sentinel, "install-owned content\n");

    expect(() => {
      materializeWorkspaceLinks(root);
    }).not.toThrow();

    expect(fs.lstatSync(link).ino).toBe(before.ino);
    expect(fs.lstatSync(link).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readlinkSync(link)).toBe("../../packages/daemon");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("install-owned content\n");
    expect(fs.readdirSync(scope).sort()).toEqual(["agentchat", "core", "daemon"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const entry of ["node_modules", "node_modules/@penumbra"]) {
  for (const kind of ["file", "symlink"]) {
    test(`workspace links reject a ${kind} at ${entry} with no declared links`, () => {
      const root = workspaceFixture({});
      try {
        const entryPath = path.join(root, entry);
        fs.mkdirSync(path.dirname(entryPath), { recursive: true });
        if (kind === "file") {
          fs.writeFileSync(entryPath, "operator-owned content\n");
        } else {
          fs.symlinkSync("packages", entryPath, "dir");
        }

        expect(() => {
          materializeWorkspaceLinks(root);
        }).toThrow(/expected real directory/);
        expect(fs.lstatSync(entryPath).isSymbolicLink()).toBe(kind === "symlink");
        if (kind === "file") {
          expect(fs.readFileSync(entryPath, "utf8")).toBe("operator-owned content\n");
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("workspace links reject a file node_modules even with no matching workspace packages", () => {
  const root = workspaceFixture({ workspaces: [] });
  try {
    fs.writeFileSync(path.join(root, "node_modules"), "operator-owned content\n");

    expect(() => {
      materializeWorkspaceLinks(root);
    }).toThrow(/expected real directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
