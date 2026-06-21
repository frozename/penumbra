import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "check-dist-freshness.ts");

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function run(packagesDir: string, args: string[] = []): RunResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    env: { ...process.env, PENUMBRA_PACKAGES_DIR: packagesDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

function setMtime(path: string, ms: number): void {
  const t = new Date(ms);
  utimesSync(path, t, t);
}

function mkPkg(root: string, name: string): string {
  const pkg = join(root, name);
  mkdirSync(join(pkg, "src"), { recursive: true });
  mkdirSync(join(pkg, "dist"), { recursive: true });
  return pkg;
}

function withTmp(fn: (root: string) => void): void {
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

  test("removes stray src js and d.ts artifacts but skips daemon src", () => {
    withTmp((root) => {
      const agentchat = join(root, "agentchat");
      mkdirSync(join(agentchat, "src", "nested"), { recursive: true });
      writeFileSync(join(agentchat, "src", "index.ts"), "export {}");
      writeFileSync(join(agentchat, "src", "index.js"), "export {}");
      writeFileSync(join(agentchat, "src", "index.d.ts"), "export {}");
      writeFileSync(join(agentchat, "src", "nested", "generated.ts"), "export {}");
      writeFileSync(join(agentchat, "src", "nested", "generated.js"), "export {}");
      writeFileSync(join(agentchat, "src", "nested", "types.ts"), "export {}");
      writeFileSync(join(agentchat, "src", "nested", "types.d.ts"), "export {}");

      const daemon = join(root, "daemon");
      mkdirSync(join(daemon, "src"), { recursive: true });
      writeFileSync(join(daemon, "src", "keep.js"), "export {}");
      writeFileSync(join(daemon, "src", "keep.d.ts"), "export {}");

      const r = run(root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("removed 4 stray src artifact");
      expect(existsSync(join(agentchat, "src", "index.js"))).toBe(false);
      expect(existsSync(join(agentchat, "src", "index.d.ts"))).toBe(false);
      expect(existsSync(join(agentchat, "src", "nested", "generated.js"))).toBe(false);
      expect(existsSync(join(agentchat, "src", "nested", "types.d.ts"))).toBe(false);
      expect(existsSync(join(agentchat, "src", "nested", "generated.ts"))).toBe(true);
      expect(existsSync(join(agentchat, "src", "nested", "types.ts"))).toBe(true);
      expect(existsSync(join(daemon, "src", "keep.js"))).toBe(true);
      expect(existsSync(join(daemon, "src", "keep.d.ts"))).toBe(true);
    });
  });
});
