import { describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SCRIPT = join(import.meta.dir, "check-dist-freshness.ts");

function run(packagesDir: string, args: string[] = []) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    env: { ...process.env, PENUMBRA_PACKAGES_DIR: packagesDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim(),
    stderr: new TextDecoder().decode(result.stderr ?? new Uint8Array()).trim(),
  };
}

function setMtime(path: string, ms: number) {
  const t = new Date(ms);
  utimesSync(path, t, t);
}

function mkPkg(root: string, name: string) {
  const pkg = join(root, name);
  mkdirSync(join(pkg, "src"), { recursive: true });
  mkdirSync(join(pkg, "dist"), { recursive: true });
  return pkg;
}

function withTmp(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "dist-check-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check-dist-freshness", () => {
  test("fresh dist → exit 0, all dist fresh", () => {
    withTmp((root) => {
      const pkg = mkPkg(root, "alpha");
      writeFileSync(join(pkg, "src", "index.ts"), "export {}");
      writeFileSync(join(pkg, "dist", "index.d.ts"), "export {}");
      setMtime(join(pkg, "src", "index.ts"), 1_000);
      setMtime(join(pkg, "dist", "index.d.ts"), 2_000);

      const r = run(root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("all dist fresh");
    });
  });

  test("stale dist → exit 0 removed=1 by default; exit 2 with --check", () => {
    withTmp((root) => {
      const pkg = mkPkg(root, "alpha");
      writeFileSync(join(pkg, "src", "index.ts"), "export {}");
      writeFileSync(join(pkg, "dist", "index.d.ts"), "export {}");
      setMtime(join(pkg, "src", "index.ts"), 2_000);
      setMtime(join(pkg, "dist", "index.d.ts"), 1_000);

      const rDefault = run(root);
      expect(rDefault.exitCode).toBe(0);
      expect(rDefault.stdout).toContain("removed 1");
      expect(existsSync(join(pkg, "dist"))).toBe(false);
    });

    withTmp((root) => {
      const pkg = mkPkg(root, "alpha");
      writeFileSync(join(pkg, "src", "index.ts"), "export {}");
      writeFileSync(join(pkg, "dist", "index.d.ts"), "export {}");
      setMtime(join(pkg, "src", "index.ts"), 2_000);
      setMtime(join(pkg, "dist", "index.d.ts"), 1_000);

      const rCheck = run(root, ["--check"]);
      expect(rCheck.exitCode).toBe(2);
      expect(existsSync(join(pkg, "dist"))).toBe(true); // not removed in check mode
    });
  });

  test("missing dist → exit 0, nothing to scrub", () => {
    withTmp((root) => {
      const pkg = join(root, "alpha");
      mkdirSync(join(pkg, "src"), { recursive: true });
      writeFileSync(join(pkg, "src", "index.ts"), "export {}");
      // no dist/ dir

      const r = run(root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("all dist fresh");
    });
  });

  test("missing src → skip package, exit 0", () => {
    withTmp((root) => {
      const pkg = join(root, "alpha");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      writeFileSync(join(pkg, "dist", "index.d.ts"), "export {}");
      // no src/ dir

      const r = run(root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("all dist fresh");
    });
  });

  test("multi-package: 2 fresh 1 stale → removes stale, leaves fresh", () => {
    withTmp((root) => {
      for (const name of ["alpha", "beta"]) {
        const pkg = mkPkg(root, name);
        writeFileSync(join(pkg, "src", "index.ts"), "export {}");
        writeFileSync(join(pkg, "dist", "index.d.ts"), "export {}");
        setMtime(join(pkg, "src", "index.ts"), 1_000);
        setMtime(join(pkg, "dist", "index.d.ts"), 2_000);
      }
      const stale = mkPkg(root, "gamma");
      writeFileSync(join(stale, "src", "index.ts"), "export {}");
      writeFileSync(join(stale, "dist", "index.d.ts"), "export {}");
      setMtime(join(stale, "src", "index.ts"), 2_000);
      setMtime(join(stale, "dist", "index.d.ts"), 1_000);

      const r = run(root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("removed 1");
      expect(existsSync(join(root, "alpha", "dist"))).toBe(true);
      expect(existsSync(join(root, "beta", "dist"))).toBe(true);
      expect(existsSync(join(root, "gamma", "dist"))).toBe(false);
    });
  });
});
