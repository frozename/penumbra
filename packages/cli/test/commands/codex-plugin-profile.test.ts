import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareCodexPluginProfilePath,
  removePreparedCodexPluginProfilePath,
  validateCodexPluginProfilePath,
} from "@src/commands/codex-plugin-profile.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codex-profile-")));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("validateCodexPluginProfilePath", () => {
  test("(1) a relative path throws /not absolute and normalized/", () => {
    expect(() => {
      validateCodexPluginProfilePath("codex-home");
    }).toThrow(/not absolute and normalized/);
  });

  test("(2) an absolute but non-normalized path throws /not absolute and normalized/", () => {
    const path = `${root}/missing/../codex`;
    expect(() => {
      validateCodexPluginProfilePath(path);
    }).toThrow(/not absolute and normalized/);
  });

  test("(3) a trailing-slash path throws /not absolute and normalized/", () => {
    const path = join(root, "codex") + "/";
    expect(() => {
      validateCodexPluginProfilePath(path);
    }).toThrow(/not absolute and normalized/);
  });

  test("(4) a path whose middle component is a symlink throws the symlink error", () => {
    mkdirSync(join(root, "real"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const path = join(root, "link", "codex");
    const linkPath = join(root, "link");
    expect(() => {
      validateCodexPluginProfilePath(path);
    }).toThrow(`Codex profile path contains a symlink: ${linkPath}`);
  });

  test("(5) a path through a regular file throws the non-directory error", () => {
    writeFileSync(join(root, "file"), "x");
    const path = join(root, "file", "codex");
    const filePart = join(root, "file");
    expect(() => {
      validateCodexPluginProfilePath(path);
    }).toThrow(`Codex profile path contains a non-directory: ${filePart}`);
  });

  test("(6) a missing leaf under an existing parent does not throw and creates nothing", () => {
    const path = join(root, "codex");
    expect(() => {
      validateCodexPluginProfilePath(path);
    }).not.toThrow();
    expect(lstatSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("(7) an existing canonical user-owned directory does not throw", () => {
    const path = join(root, "codex");
    mkdirSync(path);
    expect(() => {
      validateCodexPluginProfilePath(path);
    }).not.toThrow();
  });

  test("(8) ownership check: not owned by uid throws /not owned by uid/", () => {
    const uid = process.getuid?.();
    const skip = uid === undefined || uid === 0;
    // When uid is undefined or 0, the test is deterministically skipped.
    // On non-root users the path's nearest ancestor "/" is owned by root,
    // so validation throws /not owned by uid/.
    if (skip) return;
    const path = `/penumbra-profile-test-missing-${crypto.randomUUID()}`;
    expect(() => {
      validateCodexPluginProfilePath(path);
    }).toThrow(/not owned by uid/);
  });

  test("(16) a case-variant ancestor throws /not canonical/ on case-insensitive filesystems", () => {
    mkdirSync(join(root, "codex"));
    const path = join(root, "CODEX");
    // On a case-sensitive filesystem lstat("<root>/CODEX") is undefined and
    // the scenario cannot arise, so the test is deterministically skipped.
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return;
    expect(() => {
      validateCodexPluginProfilePath(path);
    }).toThrow(/not canonical/);
  });
});

describe("prepareCodexPluginProfilePath", () => {
  test("(9) existing directory with a file returns false, file preserved, mode unchanged", () => {
    const path = join(root, "codex");
    mkdirSync(path);
    const content = "keep this";
    writeFileSync(join(path, "keep.txt"), content);
    const beforeMode = statSync(path).mode & 0o777;

    const result = prepareCodexPluginProfilePath(path);
    expect(result).toBe(false);
    expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe(content);
    expect(statSync(path).mode & 0o777).toBe(beforeMode);
  });

  test("(10) missing parent throws /parent must exist before plugin installation/", () => {
    const path = join(root, "absent-parent", "codex");
    expect(() => prepareCodexPluginProfilePath(path)).toThrow(
      /parent must exist before plugin installation/,
    );
    expect(lstatSync(join(root, "absent-parent"), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("(11) missing leaf under existing parent creates directory with mode 0o700", () => {
    const path = join(root, "codex");
    const result = prepareCodexPluginProfilePath(path);
    expect(result).toBe(true);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  test("(12) symlinked ancestor throws symlink error and creates nothing", () => {
    mkdirSync(join(root, "real"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const path = join(root, "link", "codex");
    expect(() => prepareCodexPluginProfilePath(path)).toThrow(/symlink/);
    expect(lstatSync(join(root, "real", "codex"), { throwIfNoEntry: false })).toBeUndefined();
  });
});

describe("removePreparedCodexPluginProfilePath", () => {
  test("(13) an empty directory is removed", () => {
    const path = join(root, "codex");
    mkdirSync(path);
    expect(() => {
      removePreparedCodexPluginProfilePath(path);
    }).not.toThrow();
    expect(lstatSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("(14) a directory containing a file is preserved", () => {
    const path = join(root, "codex");
    mkdirSync(path);
    const content = '{"key": "value"}';
    writeFileSync(join(path, "state.json"), content);

    expect(() => {
      removePreparedCodexPluginProfilePath(path);
    }).not.toThrow();
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(readFileSync(join(path, "state.json"), "utf8")).toBe(content);
  });

  test("(15) a non-existent path does not throw", () => {
    const path = join(root, "does-not-exist");
    expect(() => {
      removePreparedCodexPluginProfilePath(path);
    }).not.toThrow();
    expect(lstatSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });
});
