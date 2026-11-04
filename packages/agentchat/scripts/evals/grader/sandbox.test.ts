import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import type { RunCommand } from "./materialize.js";
import type * as SandboxModule from "./sandbox.js";

const tempDirs: string[] = [];

// `true` only when this host can run a probe child under the real OS sandbox,
// so the [sbx] cases skip on unsupported hosts. Computed WITHOUT the module
// under test: darwin shells out to sandbox-exec; linux runs bwrap with the
// same bind shape the implementation is expected to use.
const HOST_SANDBOX = probeHostSandbox();

const liveServers: { stop: (closeActive?: boolean) => void }[] = [];
const liveListeners: Server[] = [];

afterEach(() => {
  for (const server of liveServers.splice(0)) {
    server.stop(true);
  }
  for (const listener of liveListeners.splice(0)) {
    listener.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function probeHostSandbox(): boolean {
  try {
    if (process.platform === "darwin") {
      return (
        spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"])
          .status === 0
      );
    }
    if (process.platform === "linux") {
      const bunPrefix = realpathSync(dirname(dirname(realpathSync(process.execPath))));
      return (
        spawnSync("bwrap", [
          "--unshare-all",
          "--die-with-parent",
          "--ro-bind",
          "/usr",
          "/usr",
          "--ro-bind-try",
          "/lib",
          "/lib",
          "--ro-bind-try",
          "/lib64",
          "/lib64",
          "--ro-bind-try",
          "/bin",
          "/bin",
          "--ro-bind",
          bunPrefix,
          bunPrefix,
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          process.execPath,
          "-e",
          "0",
        ]).status === 0
      );
    }
    return false;
  } catch {
    return false;
  }
}

async function loadSandbox(): Promise<typeof SandboxModule> {
  const mod = await import("./sandbox.js").catch(() => null);
  expect(mod).not.toBeNull();
  return mod!;
}

interface ProbeDirs {
  treeDir: string;
  depsDir: string;
  tmpRoot: string;
}

// mkdtemp on macOS lands under /var, which resolves to /private/var; every
// path handed to runProbeLeg goes through realpathSync so argv/env comparisons
// match what the sandbox layer passes down.
function mkRealTmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function mkProbeDirs(): ProbeDirs {
  return {
    treeDir: mkRealTmp("penumbra-probe-tree-"),
    depsDir: mkRealTmp("penumbra-probe-deps-"),
    tmpRoot: mkRealTmp("penumbra-probe-tmp-"),
  };
}

function writeModule(treeDir: string, source: string, rel = "cand.mjs"): string {
  writeFileSync(join(treeDir, rel), source, "utf8");
  return rel;
}

interface SpawnOptsLike {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: unknown;
}

interface SpawnRecord {
  cmd: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  stdio: unknown;
  stdin: Buffer[];
}

// Minimal ChildProcess stand-in: captures stdin bytes and, once stdin ends,
// ends stdout/stderr/fd3 empty then emits exit(0, null) and close(0, null).
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly fd3 = new PassThrough();
  readonly stdio: PassThrough[];
  pid = 43210;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(rec: SpawnRecord) {
    super();
    this.stdio = [this.stdin, this.stdout, this.stderr, this.fd3];
    this.stdin.on("data", (chunk: Buffer) => {
      rec.stdin.push(chunk);
    });
    this.stdin.on("end", () => {
      this.stdout.end();
      this.stderr.end();
      this.fd3.end();
      setImmediate(() => {
        this.exitCode = 0;
        this.emit("exit", 0, null);
        this.emit("close", 0, null);
      });
    });
    setImmediate(() => {
      this.emit("spawn");
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

function makeSpawnSpy(): { spawn: SandboxModule.SpawnFn; records: SpawnRecord[] } {
  const records: SpawnRecord[] = [];
  const spawn = (cmd: string, args: string[], opts?: SpawnOptsLike): FakeChild => {
    const rec: SpawnRecord = {
      cmd,
      args,
      cwd: opts?.cwd,
      env: opts?.env,
      stdio: opts?.stdio,
      stdin: [],
    };
    records.push(rec);
    return new FakeChild(rec);
  };
  return { spawn: spawn as unknown as SandboxModule.SpawnFn, records };
}

function hasTriple(args: string[], flag: string, value: string): boolean {
  return args.some((arg, i) => arg === flag && args[i + 1] === value && args[i + 2] === value);
}

type ProbeOpts = Parameters<typeof SandboxModule.runProbeLeg>[0];

interface LegRun {
  sandbox: SandboxModule.SandboxKind;
  leg: SandboxModule.ProbeLeg;
  timeoutMs: number;
  spawn?: SandboxModule.SpawnFn;
}

function probeOpts(dirs: ProbeDirs, run: LegRun): ProbeOpts {
  const base = {
    sandbox: run.sandbox,
    leg: run.leg,
    timeoutMs: run.timeoutMs,
    dirs: { treeDir: dirs.treeDir, depsDir: dirs.depsDir },
    bun: process.execPath,
    tmpRoot: dirs.tmpRoot,
  };
  return (run.spawn === undefined ? base : { ...base, spawn: run.spawn }) as ProbeOpts;
}

test("probe request strips non-contract fields and empty fd3 is no_output", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(dirs.treeDir, "export const f = (x) => ({ v: x });\n");
  const store = mkRealTmp("penumbra-grader-store-");
  const digest = createHash("sha256").update("r1-canary").digest("hex");
  const bundlePath = join(store, digest, "bundle.json");
  const extra = { expect: "CANARY-EXPECT", bundle_path: bundlePath, digest };
  const leg = {
    module_rel: moduleRel,
    calls: [{ id: "c1", export: "f", input: "CANARY-INPUT", ...extra }],
    ...extra,
  } as SandboxModule.ProbeLeg;
  const { spawn, records } = makeSpawnSpy();

  const res = await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "none", leg, timeoutMs: 5_000, spawn }),
  );

  expect(records).toHaveLength(1);
  const raw = Buffer.concat(records[0]!.stdin).toString("utf8");
  expect(raw).not.toContain("CANARY-EXPECT");
  expect(raw).not.toContain(bundlePath);
  expect(raw).not.toContain(digest);
  expect(raw).toContain("CANARY-INPUT");
  const frame = JSON.parse(raw) as {
    nonce: string;
    module_rel: string;
    tree: string;
    calls: { id: string; export: string; input: unknown }[];
  };
  expect(Object.keys(frame).sort()).toEqual(["calls", "module_rel", "nonce", "tree"]);
  expect(frame.module_rel).toBe(moduleRel);
  expect(frame.nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(frame.calls).toHaveLength(1);
  for (const call of frame.calls) {
    expect(Object.keys(call).sort()).toEqual(["export", "id", "input"]);
  }
  expect(res).toEqual({ kind: "no_output" });
});

test("none leg spawns bun with scrubbed env, pinned argv and piped stdio", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(dirs.treeDir, "export const f = (x) => ({ v: x });\n");
  const leg = {
    module_rel: moduleRel,
    calls: [{ id: "c1", export: "f", input: 1 }],
  } as SandboxModule.ProbeLeg;
  const { spawn, records } = makeSpawnSpy();

  const res = await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "none", leg, timeoutMs: 5_000, spawn }),
  );

  expect(res).toEqual({ kind: "no_output" });
  expect(records).toHaveLength(1);
  const rec = records[0]!;
  expect(rec.cmd).toBe(process.execPath);
  expect(rec.args).toContain("--no-install");
  expect(rec.args).toContain("--no-env-file");
  expect(rec.args).toContain(`--config=${join(sbx.GRADER_DIR, "bunfig.toml")}`);
  expect(rec.args).not.toContain("-c");
  expect(rec.args).not.toContain("--config");
  expect(rec.args.at(-1)).toBe(join(sbx.GRADER_DIR, "probe-harness.ts"));
  expect(rec.cwd).toBe(sbx.GRADER_DIR);
  const env = rec.env!;
  expect(Object.keys(env).sort()).toEqual([
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
    "HOME",
    "PATH",
    "TMPDIR",
  ]);
  expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("0");
  expect(env.HOME).toBe(env.TMPDIR);
  expect(env.HOME?.startsWith(dirs.tmpRoot)).toBe(true);
  expect(env.PATH).toBe(dirname(process.execPath));
  expect(rec.stdio).toEqual(["pipe", "pipe", "pipe", "pipe"]);
});

test("each leg gets a fresh HOME dir under tmpRoot that is removed afterwards", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(dirs.treeDir, "export const f = (x) => ({ v: x });\n");
  const leg = {
    module_rel: moduleRel,
    calls: [{ id: "c1", export: "f", input: 1 }],
  } as SandboxModule.ProbeLeg;
  const { spawn, records } = makeSpawnSpy();

  await sbx.runProbeLeg(probeOpts(dirs, { sandbox: "none", leg, timeoutMs: 5_000, spawn }));
  await sbx.runProbeLeg(probeOpts(dirs, { sandbox: "none", leg, timeoutMs: 5_000, spawn }));

  expect(records).toHaveLength(2);
  const homeA = records[0]!.env?.HOME;
  const homeB = records[1]!.env?.HOME;
  expect(homeA).toBeDefined();
  expect(homeB).toBeDefined();
  expect(homeA).not.toBe(homeB);
  expect(homeA?.startsWith(dirs.tmpRoot)).toBe(true);
  expect(homeB?.startsWith(dirs.tmpRoot)).toBe(true);
  expect(existsSync(homeA!)).toBe(false);
  expect(existsSync(homeB!)).toBe(false);
});

test("darwin-sbx leg wraps bun in sandbox-exec with -D params", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(dirs.treeDir, "export const f = (x) => ({ v: x });\n");
  const leg = {
    module_rel: moduleRel,
    calls: [{ id: "c1", export: "f", input: 1 }],
  } as SandboxModule.ProbeLeg;
  const { spawn, records } = makeSpawnSpy();

  const res = await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "darwin-sbx", leg, timeoutMs: 5_000, spawn }),
  );

  expect(res).toEqual({ kind: "no_output" });
  const rec = records[0]!;
  expect(basename(rec.cmd)).toBe("sandbox-exec");
  expect(rec.args[0]).toBe("-f");
  expect(rec.args[1]).toBe(join(sbx.GRADER_DIR, "sandbox-darwin.sb"));
  const defines = new Map<string, string>();
  for (const [i, arg] of rec.args.entries()) {
    if (arg === "-D") {
      const kv = rec.args[i + 1] ?? "";
      const eq = kv.indexOf("=");
      defines.set(eq < 0 ? kv : kv.slice(0, eq), eq < 0 ? "" : kv.slice(eq + 1));
    }
  }
  expect(defines.get("GRADER")).toBe(realpathSync(sbx.GRADER_DIR));
  expect(defines.get("TREE")).toBe(dirs.treeDir);
  expect(defines.get("DEPS")).toBe(dirs.depsDir);
  expect(defines.get("BUN")).toBe(realpathSync(process.execPath));
  expect(defines.get("TMP")?.startsWith(dirs.tmpRoot)).toBe(true);
  const bunPrefix = sbx.bunPrefix(process.execPath);
  expect(defines.get("BUNPREFIX")).toBe(bunPrefix);
  expect(existsSync(bunPrefix)).toBe(true);
  const bunIdx = Math.max(
    rec.args.indexOf(realpathSync(process.execPath)),
    rec.args.indexOf(process.execPath),
  );
  expect(bunIdx).toBeGreaterThanOrEqual(0);
  const bunArgs = rec.args.slice(bunIdx + 1);
  expect(bunArgs).toContain("--no-install");
  expect(bunArgs).toContain("--no-env-file");
  expect(bunArgs).toContain(`--config=${join(sbx.GRADER_DIR, "bunfig.toml")}`);
  expect(bunArgs).not.toContain("-c");
  expect(bunArgs).not.toContain("--config");
  expect(bunArgs.at(-1)).toBe(join(sbx.GRADER_DIR, "probe-harness.ts"));
});

test("linux-bwrap leg ro-binds inputs and bind-mounts the leg HOME", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(dirs.treeDir, "export const f = (x) => ({ v: x });\n");
  const leg = {
    module_rel: moduleRel,
    calls: [{ id: "c1", export: "f", input: 1 }],
  } as SandboxModule.ProbeLeg;
  const { spawn, records } = makeSpawnSpy();

  const res = await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "linux-bwrap", leg, timeoutMs: 5_000, spawn }),
  );

  expect(res).toEqual({ kind: "no_output" });
  const rec = records[0]!;
  expect(basename(rec.cmd)).toBe("bwrap");
  const args = rec.args;
  expect(args).toContain("--unshare-all");
  expect(args).toContain("--die-with-parent");
  expect(args).toContain("--clearenv");
  for (const v of [
    dirs.treeDir,
    realpathSync(sbx.GRADER_DIR),
    dirs.depsDir,
    "/usr",
    sbx.bunPrefix(process.execPath),
  ]) {
    expect(hasTriple(args, "--ro-bind", v)).toBe(true);
  }
  for (const v of ["/lib", "/lib64", "/bin"]) {
    expect(hasTriple(args, "--ro-bind-try", v)).toBe(true);
  }
  const home = rec.env?.HOME;
  expect(home).toBeDefined();
  expect(hasTriple(args, "--bind", home!)).toBe(true);
});

test.skipIf(!HOST_SANDBOX)(
  "[sbx] a probe cannot read files outside its bound dirs",
  async () => {
    const sbx = await loadSandbox();
    const kind = await sbx.requireSandbox();
    const dirs = mkProbeDirs();
    const store = mkRealTmp("penumbra-grader-store-");
    const digest = createHash("sha256").update("r3-canary").digest("hex");
    mkdirSync(join(store, digest));
    const bundlePath = join(store, digest, "bundle.json");
    writeFileSync(bundlePath, "CANARY-BUNDLE\n", "utf8");
    const moduleRel = writeModule(
      dirs.treeDir,
      [
        'import { readFileSync } from "node:fs";',
        "let result;",
        "try {",
        `  result = readFileSync(${JSON.stringify(bundlePath)}, "utf8");`,
        "} catch (err) {",
        "  result = String(err && err.code ? err.code : err);",
        "}",
        "export const f = () => result;",
        "",
      ].join("\n"),
    );

    const res = await sbx.runProbeLeg(
      probeOpts(dirs, {
        sandbox: kind,
        leg: {
          module_rel: moduleRel,
          calls: [{ id: "c1", export: "f", input: null }],
        },
        timeoutMs: 15_000,
      }),
    );

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") {
      return;
    }
    const entry = res.results[0]!;
    expect("output" in entry).toBe(true);
    if (!("output" in entry)) {
      return;
    }
    const out = String(entry.output);
    expect(out).not.toContain("CANARY-BUNDLE");
    expect(out).toMatch(/EPERM|EACCES|ENOENT/);
  },
  30_000,
);

test.skipIf(!HOST_SANDBOX)(
  "[sbx] a probe cannot spawn subprocesses",
  async () => {
    const sbx = await loadSandbox();
    const kind = await sbx.requireSandbox();
    const dirs = mkProbeDirs();
    const moduleRel = writeModule(
      dirs.treeDir,
      [
        'import { spawnSync } from "node:child_process";',
        'const r = spawnSync("ps", ["-o", "args=", "-p", String(process.ppid)]);',
        "export const f = () => ({",
        "  status: r.status,",
        "  error: r.error ? String(r.error.code ?? r.error.message ?? r.error) : null,",
        '  stdout: r.stdout ? r.stdout.toString("utf8") : "",',
        "});",
        "",
      ].join("\n"),
    );

    const res = await sbx.runProbeLeg(
      probeOpts(dirs, {
        sandbox: kind,
        leg: {
          module_rel: moduleRel,
          calls: [{ id: "c1", export: "f", input: null }],
        },
        timeoutMs: 15_000,
      }),
    );

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") {
      return;
    }
    const entry = res.results[0]!;
    expect("output" in entry).toBe(true);
    if (!("output" in entry)) {
      return;
    }
    const out = entry.output as { status: number | null; error: string | null; stdout: string };
    if (process.platform === "darwin") {
      expect(out.error !== null || out.status !== 0).toBe(true);
    }
    expect(out.stdout).not.toContain("sandbox.test.ts");
  },
  30_000,
);

test.skipIf(!HOST_SANDBOX)(
  "[sbx] a probe cannot reach local listeners",
  async () => {
    const sbx = await loadSandbox();
    const kind = await sbx.requireSandbox();
    const dirs = mkProbeDirs();
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (): Response => {
        requests += 1;
        return new Response("ok");
      },
    });
    liveServers.push(server);
    let connections = 0;
    const listener = createServer((sock) => {
      connections += 1;
      sock.destroy();
    });
    liveListeners.push(listener);
    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = (listener.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${String(server.port)}/`;
    const moduleRel = writeModule(
      dirs.treeDir,
      [
        'import { connect } from "node:net";',
        "async function tryFetch(url) {",
        "  try {",
        "    const ctrl = new AbortController();",
        "    const t = setTimeout(() => ctrl.abort(), 300);",
        "    await fetch(url, { signal: ctrl.signal });",
        "    clearTimeout(t);",
        '    return "fetch-ok";',
        "  } catch {",
        '    return "fetch-fail";',
        "  }",
        "}",
        "function tryConnect(port) {",
        "  return new Promise((resolve) => {",
        '    const sock = connect({ host: "127.0.0.1", port });',
        '    const t = setTimeout(() => { sock.destroy(); resolve("connect-timeout"); }, 300);',
        '    sock.on("connect", () => { clearTimeout(t); sock.end(); resolve("connect-ok"); });',
        '    sock.on("error", () => { clearTimeout(t); resolve("connect-err"); });',
        "  });",
        "}",
        "export const f = async () => ({",
        `  fetch: await tryFetch(${JSON.stringify(url)}),`,
        `  connect: await tryConnect(${String(port)}),`,
        "});",
        "",
      ].join("\n"),
    );

    const res = await sbx.runProbeLeg(
      probeOpts(dirs, {
        sandbox: kind,
        leg: {
          module_rel: moduleRel,
          calls: [{ id: "c1", export: "f", input: null }],
        },
        timeoutMs: 15_000,
      }),
    );

    expect(res.kind).toBe("ok");
    expect(requests).toBe(0);
    expect(connections).toBe(0);
  },
  30_000,
);

test.skipIf(!HOST_SANDBOX)(
  "[sbx] a probe cannot write outside its bound dirs",
  async () => {
    const sbx = await loadSandbox();
    const kind = await sbx.requireSandbox();
    const dirs = mkProbeDirs();
    const fakeHome = mkRealTmp("penumbra-probe-home-");
    mkdirSync(join(fakeHome, ".penumbra"));
    const fakeRepo = mkRealTmp("penumbra-probe-repo-");
    const targets = [
      join(fakeHome, ".penumbra", "leak.txt"),
      join(fakeRepo, "leak.txt"),
      join(dirs.treeDir, "leak.txt"),
    ];
    const moduleRel = writeModule(
      dirs.treeDir,
      [
        'import { writeFileSync } from "node:fs";',
        "const results = [];",
        `for (const p of ${JSON.stringify(targets)}) {`,
        '  try { writeFileSync(p, "leak\\n"); results.push("wrote"); }',
        "  catch (err) { results.push(String(err && err.code ? err.code : err)); }",
        "}",
        "export const f = () => results;",
        "",
      ].join("\n"),
    );

    const res = await sbx.runProbeLeg(
      probeOpts(dirs, {
        sandbox: kind,
        leg: {
          module_rel: moduleRel,
          calls: [{ id: "c1", export: "f", input: null }],
        },
        timeoutMs: 15_000,
      }),
    );

    expect(res.kind).toBe("ok");
    for (const p of targets) {
      expect(existsSync(p)).toBe(false);
    }
  },
  30_000,
);

test("candidate global patching cannot break the fd3 result channel", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const relA = writeModule(
    dirs.treeDir,
    [
      "try { globalThis.Bun = {}; } catch {}",
      'try { Object.defineProperty(globalThis, "Bun", { value: {} }); } catch {}',
      "try { process.exit = () => {}; } catch {}",
      "try { console.log = console.error = () => {}; } catch {}",
      "try { process.stdout.write = () => true; } catch {}",
      "export const f = (x) => ({ v: x });",
      "",
    ].join("\n"),
    "candA.mjs",
  );
  const relB = writeModule(dirs.treeDir, "export const f = (x) => ({ v: x });\n", "candB.mjs");
  const run = (module_rel: string): Promise<SandboxModule.LegResult> =>
    sbx.runProbeLeg(
      probeOpts(dirs, {
        sandbox: "none",
        leg: { module_rel, calls: [{ id: "c1", export: "f", input: 1 }] },
        timeoutMs: 15_000,
      }),
    );

  const expected = { kind: "ok", results: [{ id: "c1", output: { v: 1 } }] };
  expect(await run(relA)).toEqual(expected);
  expect(await run(relB)).toEqual(expected);
}, 30_000);

test("a candidate that hangs at import is killed at timeoutMs", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(dirs.treeDir, "while (true) {}\nexport const f = () => 0;\n");

  const started = Date.now();
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: null }] },
      timeoutMs: 500,
    }),
  );

  expect(Date.now() - started).toBeLessThan(5_000);
  expect(res).toEqual({ kind: "timeout" });
}, 15_000);

test("detectSandbox returns none and requireSandbox throws when no sandbox exists", async () => {
  const sbx = await loadSandbox();
  let ran = 0;
  const runCommand: RunCommand = () => {
    ran += 1;
    return Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  };
  const which = (): string | null => null;

  expect(await sbx.detectSandbox({ platform: "darwin", which, runCommand })).toBe("none");
  expect(await sbx.detectSandbox({ platform: "linux", which, runCommand })).toBe("none");
  expect(ran).toBe(0);
  // bun:test's `.rejects` matchers are typed as returning void; await manually.
  let caught: unknown;
  try {
    await sbx.requireSandbox({ platform: "darwin", which, runCommand });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(sbx.SandboxUnavailableError);
});

test("JSON.stringify patching at import does not corrupt results", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    ["JSON.stringify = () => '\"same\"';", "export const f = (x) => ({ v: x });", ""].join("\n"),
  );

  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: 1 }] },
      timeoutMs: 15_000,
    }),
  );

  expect(res).toEqual({ kind: "ok", results: [{ id: "c1", output: { v: 1 } }] });
}, 30_000);

test("an fd3 frame with a forged nonce is reported as tamper", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    [
      'import { writeSync } from "node:fs";',
      'writeSync(3, "deadbeefdeadbeefdeadbeefdeadbeef [{\\"id\\":\\"c1\\",\\"output\\":1}]\\n");',
      'writeSync(1, "noise\\n");',
      "export const f = (x) => ({ v: x });",
      "",
    ].join("\n"),
  );

  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: 1 }] },
      timeoutMs: 15_000,
    }),
  );

  expect(res).toEqual({ kind: "tamper" });
}, 30_000);

test("toJSON, getter and proxy outputs become per-call non_plain_output errors", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    [
      "export const a = () => ({ toJSON() { return 1; } });",
      "export const b = () => {",
      "  const o = {};",
      '  Object.defineProperty(o, "x", { enumerable: true, get: () => 1 });',
      "  return o;",
      "};",
      "export const c = () => new Proxy({}, {});",
      "",
    ].join("\n"),
  );

  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: {
        module_rel: moduleRel,
        calls: [
          { id: "a", export: "a", input: null },
          { id: "b", export: "b", input: null },
          { id: "c", export: "c", input: null },
        ],
      },
      timeoutMs: 15_000,
    }),
  );

  expect(res).toEqual({
    kind: "ok",
    results: [
      { id: "a", error: "non_plain_output" },
      { id: "b", error: "non_plain_output" },
      { id: "c", error: "non_plain_output" },
    ],
  });
}, 30_000);

test("a candidate that throws at import yields per-call import_failed", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    'throw new Error("import-boom");\nexport const f = () => 0;\n',
  );

  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: {
        module_rel: moduleRel,
        calls: [
          { id: "c1", export: "f", input: null },
          { id: "c2", export: "f", input: null },
        ],
      },
      timeoutMs: 15_000,
    }),
  );

  expect(res).toEqual({
    kind: "ok",
    results: [
      { id: "c1", error: "import_failed" },
      { id: "c2", error: "import_failed" },
    ],
  });
}, 30_000);

test("a candidate that kills itself at import yields no_output", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    'process.kill(process.pid, "SIGKILL");\nexport const f = () => 0;\n',
  );

  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: null }] },
      timeoutMs: 15_000,
    }),
  );

  expect(res).toEqual({ kind: "no_output" });
}, 30_000);
