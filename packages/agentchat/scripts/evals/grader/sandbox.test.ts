import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  fd3Path: string | null;
  stdin: Buffer[];
}

// The spawn options carry the frame-file path under a module-private symbol;
// it is identified by description so the suite can assert where the frame
// lands without the implementation exporting the symbol.
function fd3PathFromOpts(opts: unknown): string | null {
  if (typeof opts !== "object" || opts === null) {
    return null;
  }
  for (const sym of Object.getOwnPropertySymbols(opts)) {
    if (sym.description === "penumbra.probe-fd3") {
      const value: unknown = Reflect.get(opts, sym);
      return typeof value === "string" ? value : null;
    }
  }
  return null;
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

  constructor(rec: SpawnRecord, hooks: SpyHooks = {}) {
    super();
    this.stdio = [this.stdin, this.stdout, this.stderr, this.fd3];
    this.stdin.on("data", (chunk: Buffer) => {
      rec.stdin.push(chunk);
    });
    this.stdin.on("end", () => {
      if (hooks.frame !== undefined) {
        const text = hooks.frame(Buffer.concat(rec.stdin).toString("utf8"));
        if (text !== null) {
          this.fd3.write(text);
        }
      }
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
      if (hooks.emitError === true) {
        this.emit("error", new Error("fake spawn failure"));
        return;
      }
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

interface SpyHooks {
  frame?: (payload: string) => string | null;
  emitError?: boolean;
}

function makeSpawnSpy(hooks: SpyHooks = {}): {
  spawn: SandboxModule.SpawnFn;
  records: SpawnRecord[];
  children: FakeChild[];
} {
  const records: SpawnRecord[] = [];
  const children: FakeChild[] = [];
  const spawn = (cmd: string, args: string[], opts?: SpawnOptsLike): FakeChild => {
    const rec: SpawnRecord = {
      cmd,
      args,
      cwd: opts?.cwd,
      env: opts?.env,
      stdio: opts?.stdio,
      fd3Path: fd3PathFromOpts(opts),
      stdin: [],
    };
    records.push(rec);
    const child = new FakeChild(rec, hooks);
    children.push(child);
    return child;
  };
  return { spawn: spawn as unknown as SandboxModule.SpawnFn, records, children };
}

function spawnSpyThrows(): SandboxModule.SpawnFn {
  return (): never => {
    throw new Error("spawn exploded");
  };
}

// Frame helpers: a valid frame is `<nonce> <json-array>\n` where the array
// has one entry per leg call, in order. `bodyOf` lets a test keep the honest
// nonce (read from the payload) and vary only the frame's shape.
function frameBody(payload: string, body: string): string {
  const parsed = JSON.parse(payload) as { nonce: string };
  return `${parsed.nonce} ${body}\n`;
}

function okBody(id: string, output: unknown): string {
  return `[{"id":${JSON.stringify(id)},"output":${JSON.stringify(output)}}]`;
}

function frameFor(payload: string, id: string, output: unknown): string {
  return frameBody(payload, okBody(id, output));
}

const FORGED_NONCE = "deadbeefdeadbeefdeadbeefdeadbeef";

function expectKind(res: SandboxModule.LegResult, kind: string): void {
  expect(res.kind).toBe(kind);
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
  expect(readdirSync(dirs.tmpRoot).filter((name) => name.startsWith("probe-fd3-"))).toEqual([]);
  expect(readdirSync(dirs.tmpRoot).filter((name) => name.startsWith("probe-leg-"))).toEqual([]);
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

// Closing fd 3 makes the harness's final writeSync throw out of main() into
// the top-level catch. The catch must hardStop (SIGKILL): process.exit would
// run the candidate's 'exit' listeners, which here write a marker the parent
// can observe. f opens no file of its own so nothing can reuse fd 3.
test("a harness failure after the candidate ran hard-stops without running exit hooks", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const markerDir = mkRealTmp("penumbra-probe-marker-");
  const markerPath = join(markerDir, "exit-hook-ran");
  const moduleRel = writeModule(
    dirs.treeDir,
    [
      'import { closeSync, writeFileSync } from "node:fs";',
      `process.on("exit", () => { writeFileSync(${JSON.stringify(markerPath)}, "ran\\n"); });`,
      "export const f = () => { closeSync(3); return 1; };",
      "",
    ].join("\n"),
  );

  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: null }] },
      timeoutMs: 15_000,
    }),
  );

  expect(res).toEqual({ kind: "no_output" });
  expect(existsSync(markerPath)).toBe(false);
}, 30_000);

function singleLeg(moduleRel: string): SandboxModule.ProbeLeg {
  return { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: null }] };
}

async function frameCase(
  sbx: typeof SandboxModule,
  frame: (payload: string) => string,
  leg?: SandboxModule.ProbeLeg,
): Promise<SandboxModule.LegResult> {
  const dirs = mkProbeDirs();
  const { spawn } = makeSpawnSpy({ frame });
  return await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: leg ?? singleLeg("cand.mjs"),
      timeoutMs: 5_000,
      spawn,
    }),
  );
}

test("an honest fd3 frame written by the child is accepted as ok", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => frameFor(payload, "c1", 1));
  expect(res).toEqual({ kind: "ok", results: [{ id: "c1", output: 1 }] });
});

test("a single frame with a wrong nonce is tamper even when otherwise well-formed", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, () => `${FORGED_NONCE} ${okBody("c1", 1)}\n`);
  expectKind(res, "tamper");
});

test("a frame whose nonce prefix is truncated is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(
    sbx,
    (payload) => `${nonceOf(payload).slice(0, 31)} ${okBody("c1", 1)}\n`,
  );
  expectKind(res, "tamper");
});

test("a frame with fewer results than calls is tamper", async () => {
  const sbx = await loadSandbox();
  const leg: SandboxModule.ProbeLeg = {
    module_rel: "cand.mjs",
    calls: [
      { id: "c1", export: "f", input: null },
      { id: "c2", export: "f", input: null },
    ],
  };
  const res = await frameCase(sbx, (payload) => frameFor(payload, "c1", 1), leg);
  expectKind(res, "tamper");
});

test("a frame with more results than calls is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(
    sbx,
    (payload) => frameBody(payload, `${okBody("c1", 1).slice(0, -1)},${okBody("c2", 2).slice(1)}`),
    singleLeg("cand.mjs"),
  );
  expectKind(res, "tamper");
});

test("a frame entry whose id does not match the call is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => frameFor(payload, "other", 1));
  expectKind(res, "tamper");
});

test("a frame entry carrying both output and error is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) =>
    frameBody(payload, '[{"id":"c1","output":1,"error":"x"}]'),
  );
  expectKind(res, "tamper");
});

test("a frame entry with neither output nor error is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => frameBody(payload, '[{"id":"c1"}]'));
  expectKind(res, "tamper");
});

test("a frame entry with an unrecognized second key is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => frameBody(payload, '[{"id":"c1","value":1}]'));
  expectKind(res, "tamper");
});

test("a frame entry whose error is not a string is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => frameBody(payload, '[{"id":"c1","error":42}]'));
  expectKind(res, "tamper");
});

test("two concatenated frames are tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(
    sbx,
    (payload) => frameFor(payload, "c1", 1) + frameFor(payload, "c1", 2),
  );
  expectKind(res, "tamper");
});

test("a frame without a trailing newline is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => `${nonceOf(payload)} ${okBody("c1", 1)}`);
  expectKind(res, "tamper");
});

test("a frame whose body is not JSON is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => frameBody(payload, "not json"));
  expectKind(res, "tamper");
});

test("a frame whose body is a JSON object instead of an array is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => frameBody(payload, '{"id":"c1","output":1}'));
  expectKind(res, "tamper");
});

test("a frame body ending with a space and no trailing newline is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => `${nonceOf(payload)} ${okBody("c1", 1)} `);
  expectKind(res, "tamper");
});

test("a frame body with a null entry is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => frameBody(payload, "[null]"));
  expectKind(res, "tamper");
});

test("a frame body with an empty results section is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => frameBody(payload, ""));
  expectKind(res, "tamper");
});

test("a frame prefixed by a blank line is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => `\n${frameFor(payload, "c1", 1)}`);
  expectKind(res, "tamper");
});

test("a frame followed by an extra empty line is tamper", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => `${frameFor(payload, "c1", 1)}\n`);
  expectKind(res, "tamper");
});

test("a null output in a valid frame is accepted as ok", async () => {
  const sbx = await loadSandbox();
  const res = await frameCase(sbx, (payload) => frameFor(payload, "c1", null));
  expect(res).toEqual({ kind: "ok", results: [{ id: "c1", output: null }] });
});

test("a frame larger than the 1 MiB cap is tamper and kills the child", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const { spawn, children } = makeSpawnSpy({
    frame: (payload) => frameBody(payload, "x".repeat(2 * 1024 * 1024)),
  });
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "none", leg: singleLeg("cand.mjs"), timeoutMs: 10_000, spawn }),
  );
  expectKind(res, "tamper");
  expect(children[0]?.killed).toBe(true);
});

test("each leg run gets a fresh nonce", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const { spawn, records } = makeSpawnSpy();
  await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "none", leg: singleLeg("cand.mjs"), timeoutMs: 5_000, spawn }),
  );
  await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "none", leg: singleLeg("cand.mjs"), timeoutMs: 5_000, spawn }),
  );
  const nonceA = nonceOf(Buffer.concat(records[0]!.stdin).toString("utf8"));
  const nonceB = nonceOf(Buffer.concat(records[1]!.stdin).toString("utf8"));
  expect(nonceA).toMatch(/^[0-9a-f]{32}$/);
  expect(nonceB).toMatch(/^[0-9a-f]{32}$/);
  expect(nonceA).not.toBe(nonceB);
});

test("the frame file is handed to spawn outside the leg HOME visible to the child", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const { spawn, records } = makeSpawnSpy();
  await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "none", leg: singleLeg("cand.mjs"), timeoutMs: 5_000, spawn }),
  );
  const rec = records[0]!;
  expect(rec.fd3Path).not.toBeNull();
  expect(rec.fd3Path!.startsWith(`${dirs.tmpRoot}/`)).toBe(true);
  const childHome = rec.env?.HOME ?? "";
  expect(childHome.length).toBeGreaterThan(0);
  expect(rec.fd3Path!.startsWith(`${childHome}/`)).toBe(false);
});

test("a spawn function that throws resolves no_output", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: singleLeg("cand.mjs"),
      timeoutMs: 5_000,
      spawn: spawnSpyThrows(),
    }),
  );
  expect(res).toEqual({ kind: "no_output" });
});

test("a child error event resolves no_output", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const { spawn } = makeSpawnSpy({ emitError: true });
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "none", leg: singleLeg("cand.mjs"), timeoutMs: 5_000, spawn }),
  );
  expect(res).toEqual({ kind: "no_output" });
});

interface SmokeCall {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

function smokeRunCommand(code: number, calls: SmokeCall[]): RunCommand {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    return Promise.resolve({ code, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  };
}

function rejectingRunCommand(): RunCommand {
  return () => Promise.reject(new Error("smoke exploded"));
}

const whichFound = (): string | null => "/usr/bin/sandbox-exec";

function darwinDefines(args: string[]): Map<string, string> {
  const defines = new Map<string, string>();
  for (const [i, arg] of args.entries()) {
    if (arg === "-D") {
      const kv = args[i + 1] ?? "";
      const eq = kv.indexOf("=");
      defines.set(eq < 0 ? kv : kv.slice(0, eq), eq < 0 ? "" : kv.slice(eq + 1));
    }
  }
  return defines;
}

function argvDirs(sbx: typeof SandboxModule): SandboxModule.SandboxDirs {
  const dirs = mkProbeDirs();
  return {
    bun: process.execPath,
    graderDir: sbx.GRADER_DIR,
    treeDir: dirs.treeDir,
    depsDir: dirs.depsDir,
    legTmp: dirs.tmpRoot,
  };
}

test("detectSandbox on an unsupported platform returns none without probing", async () => {
  const sbx = await loadSandbox();
  const calls: SmokeCall[] = [];
  let whichCalls = 0;
  const kind = await sbx.detectSandbox({
    platform: "win32",
    which: () => {
      whichCalls += 1;
      return "/usr/bin/whatever";
    },
    runCommand: smokeRunCommand(0, calls),
  });
  expect(kind).toBe("none");
  expect(whichCalls).toBe(0);
  expect(calls).toHaveLength(0);
});

test("detectSandbox returns darwin-sbx when the darwin smoke run exits 0", async () => {
  const sbx = await loadSandbox();
  const kind = await sbx.detectSandbox({
    platform: "darwin",
    which: whichFound,
    runCommand: smokeRunCommand(0, []),
  });
  expect(kind).toBe("darwin-sbx");
});

test("detectSandbox returns none when the darwin smoke run exits non-zero", async () => {
  const sbx = await loadSandbox();
  const kind = await sbx.detectSandbox({
    platform: "darwin",
    which: whichFound,
    runCommand: smokeRunCommand(1, []),
  });
  expect(kind).toBe("none");
});

test("detectSandbox returns none when the darwin smoke run rejects", async () => {
  const sbx = await loadSandbox();
  const kind = await sbx.detectSandbox({
    platform: "darwin",
    which: whichFound,
    runCommand: rejectingRunCommand(),
  });
  expect(kind).toBe("none");
});

test("detectSandbox returns linux-bwrap when the linux smoke run exits 0", async () => {
  const sbx = await loadSandbox();
  const kind = await sbx.detectSandbox({
    platform: "linux",
    which: whichFound,
    runCommand: smokeRunCommand(0, []),
  });
  expect(kind).toBe("linux-bwrap");
});

test("detectSandbox returns none when the linux smoke run exits non-zero", async () => {
  const sbx = await loadSandbox();
  const kind = await sbx.detectSandbox({
    platform: "linux",
    which: whichFound,
    runCommand: smokeRunCommand(127, []),
  });
  expect(kind).toBe("none");
});

test("detectSandbox returns none when the linux smoke run rejects", async () => {
  const sbx = await loadSandbox();
  const kind = await sbx.detectSandbox({
    platform: "linux",
    which: whichFound,
    runCommand: rejectingRunCommand(),
  });
  expect(kind).toBe("none");
});

test("the darwin smoke run wraps bun in sandbox-exec with the seatbelt profile", async () => {
  const sbx = await loadSandbox();
  const calls: SmokeCall[] = [];
  await sbx.detectSandbox({
    platform: "darwin",
    which: whichFound,
    runCommand: smokeRunCommand(0, calls),
  });
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.cmd).toBe("/usr/bin/sandbox-exec");
  expect(call.args[0]).toBe("-f");
  expect(call.args[1]).toBe(join(sbx.GRADER_DIR, "sandbox-darwin.sb"));
  expect(call.args.at(-3)).toBe(realpathSync(process.execPath));
  expect(call.args.slice(-2)).toEqual(["-e", "0"]);
});

test("the linux smoke run invokes bwrap with the unshare/clearenv preamble", async () => {
  const sbx = await loadSandbox();
  const calls: SmokeCall[] = [];
  await sbx.detectSandbox({
    platform: "linux",
    which: whichFound,
    runCommand: smokeRunCommand(0, calls),
  });
  const call = calls[0]!;
  expect(call.cmd).toBe("bwrap");
  expect(call.args).toContain("--unshare-all");
  expect(call.args).toContain("--die-with-parent");
  expect(call.args).toContain("--clearenv");
});

test("the smoke run gets only the scrubbed probe env", async () => {
  const sbx = await loadSandbox();
  const calls: SmokeCall[] = [];
  await sbx.detectSandbox({
    platform: "darwin",
    which: whichFound,
    runCommand: smokeRunCommand(0, calls),
  });
  const env = calls[0]!.env!;
  expect(Object.keys(env).sort()).toEqual([
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
    "HOME",
    "PATH",
    "TMPDIR",
  ]);
  expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("0");
  expect(env.HOME).toBe(env.TMPDIR);
});

test("the smoke run removes its scratch dirs after resolving", async () => {
  const sbx = await loadSandbox();
  const calls: SmokeCall[] = [];
  await sbx.detectSandbox({
    platform: "darwin",
    which: whichFound,
    runCommand: smokeRunCommand(0, calls),
  });
  const home = calls[0]!.env?.HOME;
  expect(home).toBeDefined();
  expect(existsSync(home!)).toBe(false);
});

test("detectSandbox honors an explicit bun override in the smoke argv", async () => {
  const sbx = await loadSandbox();
  const calls: SmokeCall[] = [];
  await sbx.detectSandbox({
    platform: "darwin",
    which: whichFound,
    runCommand: smokeRunCommand(0, calls),
    bun: "/bin/echo",
  });
  expect(calls[0]!.args).toContain(realpathSync("/bin/echo"));
});

test("requireSandbox resolves the detected kind when a sandbox works", async () => {
  const sbx = await loadSandbox();
  const kind = await sbx.requireSandbox({
    platform: "linux",
    which: whichFound,
    runCommand: smokeRunCommand(0, []),
  });
  expect(kind).toBe("linux-bwrap");
});

test("sandboxArgv for none runs bun directly with the harness args", async () => {
  const sbx = await loadSandbox();
  const dirs = argvDirs(sbx);
  const argv = sbx.sandboxArgv("none", dirs, ["-e", "0"]);
  expect(argv.cmd).toBe(process.execPath);
  expect(argv.args).toEqual(["-e", "0"]);
});

test("sandboxArgv for darwin passes exactly the six documented defines", async () => {
  const sbx = await loadSandbox();
  const dirs = argvDirs(sbx);
  const argv = sbx.sandboxArgv("darwin-sbx", dirs, ["-e", "0"]);
  const defines = darwinDefines(argv.args);
  expect([...defines.keys()].sort()).toEqual(["BUN", "BUNPREFIX", "DEPS", "GRADER", "TMP", "TREE"]);
  expect(defines.get("TREE")).toBe(dirs.treeDir);
  expect(defines.get("DEPS")).toBe(dirs.depsDir);
  expect(defines.get("TMP")).toBe(dirs.legTmp);
});

test("sandboxArgv for darwin resolves symlinked inputs to their realpaths", async () => {
  const sbx = await loadSandbox();
  const dirs = argvDirs(sbx);
  const target = mkRealTmp("penumbra-link-target-");
  const linkRoot = mkRealTmp("penumbra-link-root-");
  const link = join(linkRoot, "tree-link");
  symlinkSync(target, link);
  const argv = sbx.sandboxArgv("darwin-sbx", { ...dirs, treeDir: link }, ["-e", "0"]);
  expect(darwinDefines(argv.args).get("TREE")).toBe(target);
});

test("sandboxArgv for darwin appends the harness args after the resolved bun", async () => {
  const sbx = await loadSandbox();
  const dirs = argvDirs(sbx);
  const argv = sbx.sandboxArgv("darwin-sbx", dirs, ["-e", "0"]);
  const bunIdx = argv.args.lastIndexOf(realpathSync(process.execPath));
  expect(bunIdx).toBeGreaterThanOrEqual(0);
  expect(argv.args.slice(bunIdx + 1)).toEqual(["-e", "0"]);
});

test("sandboxArgv for linux mounts proc and dev pseudo-filesystems", async () => {
  const sbx = await loadSandbox();
  const dirs = argvDirs(sbx);
  const args = sbx.sandboxArgv("linux-bwrap", dirs, ["-e", "0"]).args;
  const procIdx = args.indexOf("--proc");
  expect(procIdx).toBeGreaterThanOrEqual(0);
  expect(args[procIdx + 1]).toBe("/proc");
  const devIdx = args.indexOf("--dev");
  expect(devIdx).toBeGreaterThanOrEqual(0);
  expect(args[devIdx + 1]).toBe("/dev");
});

test("sandboxArgv for linux chdirs into the real grader directory", async () => {
  const sbx = await loadSandbox();
  const dirs = argvDirs(sbx);
  const args = sbx.sandboxArgv("linux-bwrap", dirs, ["-e", "0"]).args;
  const chdirIdx = args.indexOf("--chdir");
  expect(chdirIdx).toBeGreaterThanOrEqual(0);
  expect(args[chdirIdx + 1]).toBe(realpathSync(sbx.GRADER_DIR));
});

test("sandboxArgv for linux injects exactly the scrubbed env via setenv", async () => {
  const sbx = await loadSandbox();
  const dirs = argvDirs(sbx);
  const args = sbx.sandboxArgv("linux-bwrap", dirs, ["-e", "0"]).args;
  const setenv = new Map<string, string>();
  for (const [i, arg] of args.entries()) {
    if (arg === "--setenv") {
      const key = args[i + 1];
      const value = args[i + 2];
      if (key !== undefined && value !== undefined) {
        setenv.set(key, value);
      }
    }
  }
  expect([...setenv.keys()].sort()).toEqual([
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
    "HOME",
    "PATH",
    "TMPDIR",
  ]);
  expect(setenv.get("HOME")).toBe(dirs.legTmp);
  expect(setenv.get("TMPDIR")).toBe(dirs.legTmp);
  expect(setenv.get("PATH")).toBe(dirname(realpathSync(process.execPath)));
  expect(setenv.get("BUN_RUNTIME_TRANSPILER_CACHE_PATH")).toBe("0");
});

test("sandboxArgv for linux appends the harness args after the resolved bun", async () => {
  const sbx = await loadSandbox();
  const dirs = argvDirs(sbx);
  const argv = sbx.sandboxArgv("linux-bwrap", dirs, ["-e", "0"]);
  const bunIdx = argv.args.lastIndexOf(realpathSync(process.execPath));
  expect(bunIdx).toBeGreaterThanOrEqual(0);
  expect(argv.args.slice(bunIdx + 1)).toEqual(["-e", "0"]);
});

test("bunPrefix is the realpath of the grandparent directory of the bun binary", async () => {
  const sbx = await loadSandbox();
  const real = realpathSync(process.execPath);
  expect(sbx.bunPrefix(process.execPath)).toBe(realpathSync(join(real, "..", "..")));
});

function nonceOf(payload: string): string {
  const parsed = JSON.parse(payload) as { nonce: string };
  return parsed.nonce;
}

function expectUnsafeRel(records: SpawnRecord[], tmpRoot: string, caught: unknown): void {
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).toContain("unsafe module_rel");
  expect(records).toHaveLength(0);
  expect(readdirSync(tmpRoot)).toEqual([]);
}

async function runExpectThrow(sbx: typeof SandboxModule, moduleRel: string): Promise<void> {
  const dirs = mkProbeDirs();
  const { spawn, records } = makeSpawnSpy();
  let caught: unknown;
  try {
    await sbx.runProbeLeg(
      probeOpts(dirs, {
        sandbox: "none",
        leg: { module_rel: moduleRel, calls: [] },
        timeoutMs: 5_000,
        spawn,
      }),
    );
  } catch (err) {
    caught = err;
  }
  expectUnsafeRel(records, dirs.tmpRoot, caught);
}

test("runProbeLeg rejects a parent-traversing module_rel before spawning", async () => {
  const sbx = await loadSandbox();
  await runExpectThrow(sbx, "../evil.mjs");
});

test("runProbeLeg rejects an absolute module_rel before spawning", async () => {
  const sbx = await loadSandbox();
  await runExpectThrow(sbx, "/etc/passwd");
});

test("runProbeLeg rejects a mid-path traversal module_rel before spawning", async () => {
  const sbx = await loadSandbox();
  await runExpectThrow(sbx, "packages/../evil.mjs");
});

test("runProbeLeg rejects an empty module_rel before spawning", async () => {
  const sbx = await loadSandbox();
  await runExpectThrow(sbx, "");
});

test("runProbeLeg rejects a .git module_rel before spawning", async () => {
  const sbx = await loadSandbox();
  await runExpectThrow(sbx, ".git/hooks/evil.mjs");
});

test("a plain candidate module returns its honest output through the real spawn path", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(dirs.treeDir, "export const f = (x) => ({ v: x });\n");
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: { a: 1 } }] },
      timeoutMs: 15_000,
    }),
  );
  expect(res).toEqual({ kind: "ok", results: [{ id: "c1", output: { v: { a: 1 } } }] });
}, 30_000);

test("multiple calls return in request order through the real spawn path", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    ["export const f = (x) => ({ v: x });", "export const g = (x) => ({ w: x });", ""].join("\n"),
  );
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: {
        module_rel: moduleRel,
        calls: [
          { id: "c1", export: "f", input: 1 },
          { id: "c2", export: "g", input: "s" },
        ],
      },
      timeoutMs: 15_000,
    }),
  );
  expect(res).toEqual({
    kind: "ok",
    results: [
      { id: "c1", output: { v: 1 } },
      { id: "c2", output: { w: "s" } },
    ],
  });
}, 30_000);

test("a missing export yields a per-call call_failed through the real spawn path", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(dirs.treeDir, "export const f = () => 1;\n");
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "missing", input: null }] },
      timeoutMs: 15_000,
    }),
  );
  expect(res).toEqual({ kind: "ok", results: [{ id: "c1", error: "call_failed" }] });
}, 30_000);

test("a candidate that throws inside the call yields call_failed", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    'export const f = () => { throw new Error("boom"); };\n',
  );
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: null }] },
      timeoutMs: 15_000,
    }),
  );
  expect(res).toEqual({ kind: "ok", results: [{ id: "c1", error: "call_failed" }] });
}, 30_000);

test("an async candidate export is awaited before framing", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    [
      "export const f = async (x) => {",
      "  await new Promise((resolve) => setTimeout(resolve, 10));",
      "  return { ok: true, x };",
      "};",
      "",
    ].join("\n"),
  );
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: 2 }] },
      timeoutMs: 15_000,
    }),
  );
  expect(res).toEqual({ kind: "ok", results: [{ id: "c1", output: { ok: true, x: 2 } }] });
}, 30_000);

test("the fd 3 inherited by the candidate is not readable", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    [
      'import { readSync } from "node:fs";',
      'let code = "readable";',
      "try {",
      "  const b = Buffer.alloc(64);",
      "  const n = readSync(3, b, 0, 64, 0);",
      '  code = "read-" + String(n);',
      "} catch (err) {",
      "  code = String(err && err.code ? err.code : err);",
      "}",
      "export const f = () => code;",
      "",
    ].join("\n"),
  );
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: null }] },
      timeoutMs: 15_000,
    }),
  );
  expect(res).toEqual({ kind: "ok", results: [{ id: "c1", output: "EBADF" }] });
}, 30_000);

const FORGE_EXIT_MODULE = [
  'import { ftruncateSync, readSync, writeSync } from "node:fs";',
  'process.on("exit", () => {',
  "  try {",
  "    const buf = Buffer.alloc(256);",
  "    let n = 0;",
  "    try { n = readSync(3, buf, 0, 256, 0); } catch { n = 0; }",
  '    const nonce = buf.toString("utf8", 0, n).slice(0, 32);',
  "    try { ftruncateSync(3, 0); } catch { /* append-only fd */ }",
  '    writeSync(3, nonce + " [{\\"id\\":\\"c1\\",\\"output\\":\\"FORGED\\"}]\\n", 0);',
  "  } catch { /* fd gone */ }",
  "});",
  "export const f = (x) => ({ v: x });",
  "",
].join("\n");

function expectNeverForged(res: SandboxModule.LegResult): void {
  if (res.kind === "ok") {
    expect(res.results).toEqual([{ id: "c1", output: { v: 1 } }]);
  } else {
    expect(res.kind).toBe("tamper");
  }
}

test("a candidate exit hook cannot pread the nonce and rewrite the frame to a forged ok", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(dirs.treeDir, FORGE_EXIT_MODULE);
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: 1 }] },
      timeoutMs: 15_000,
    }),
  );
  expectNeverForged(res);
}, 30_000);

test("a candidate exit hook cannot append a second forged line to the committed frame", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    [
      'import { writeSync } from "node:fs";',
      'process.on("exit", () => {',
      '  try { writeSync(3, "abc [{\\"id\\":\\"c1\\",\\"output\\":\\"FORGED\\"}]\\n"); } catch {}',
      "});",
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
  expectNeverForged(res);
}, 30_000);

// An exit hook that leaves two independent traces: an extra fd-3 line (which
// classifyFd3 must never see, even under the sandbox where inherited-fd
// writes go through) and a marker file in the tree (writable only on the
// default path). Any harness mutant that runs exit listeners — replacing
// hardStop's SIGKILL with exit(0), or dropping the killPid call so exit(1)
// runs the hooks — turns both assertions red.
function hardStopExitModule(markerPath: string): string {
  return [
    'import { writeFileSync, writeSync } from "node:fs";',
    'process.on("exit", () => {',
    `  try { writeFileSync(${JSON.stringify(markerPath)}, "exit-hook-ran\\n"); } catch {}`,
    '  try { writeSync(3, "exit-hook-appended\\n"); } catch {}',
    "});",
    "export const f = (x) => ({ v: x });",
    "",
  ].join("\n");
}

test("the hard stop kills the child without running candidate exit hooks", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const markerPath = join(dirs.treeDir, "exit-hook-marker");
  const moduleRel = writeModule(dirs.treeDir, hardStopExitModule(markerPath));
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: 1 }] },
      timeoutMs: 15_000,
    }),
  );
  expect(res).toEqual({ kind: "ok", results: [{ id: "c1", output: { v: 1 } }] });
  expect(existsSync(markerPath)).toBe(false);
}, 30_000);

test.skipIf(!HOST_SANDBOX)(
  "[sbx] the hard stop kills the sandboxed child without running candidate exit hooks",
  async () => {
    const sbx = await loadSandbox();
    const kind = await sbx.requireSandbox();
    const dirs = mkProbeDirs();
    const markerPath = join(dirs.treeDir, "exit-hook-marker");
    const moduleRel = writeModule(dirs.treeDir, hardStopExitModule(markerPath));
    const res = await sbx.runProbeLeg(
      probeOpts(dirs, {
        sandbox: kind,
        leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: 1 }] },
        timeoutMs: 15_000,
      }),
    );
    expect(res).toEqual({ kind: "ok", results: [{ id: "c1", output: { v: 1 } }] });
    expect(existsSync(markerPath)).toBe(false);
  },
  30_000,
);

test("the harness terminates even when the candidate keeps the loop alive", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    ["setInterval(() => undefined, 1000);", "export const f = (x) => ({ v: x });", ""].join("\n"),
  );
  const started = Date.now();
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: 1 }] },
      timeoutMs: 15_000,
    }),
  );
  expect(res).toEqual({ kind: "ok", results: [{ id: "c1", output: { v: 1 } }] });
  expect(Date.now() - started).toBeLessThan(10_000);
}, 30_000);

test("writing more than the fd-3 cap from the candidate is tamper", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    [
      'import { writeSync } from "node:fs";',
      'writeSync(3, "x".repeat(2 * 1024 * 1024) + "\\n");',
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
  expectKind(res, "tamper");
}, 30_000);

// The candidate cannot forge the nonce, so an oversized frame that still
// carries the honest nonce can only come from the harness itself: a huge
// export return value. Removing readFd3File's `size > FD3_LIMIT_BYTES`
// check would parse it as ok, so the assertion here pins the cap on the
// default (frame-file) path.
test("an honest frame above the 1 MiB cap is tamper on the default file path", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    'export const f = () => "a".repeat(2 * 1024 * 1024);\n',
  );
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "none", leg: singleLeg(moduleRel), timeoutMs: 15_000 }),
  );
  expectKind(res, "tamper");
}, 30_000);

test("an honest frame just under the 1 MiB cap is ok on the default file path", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    `export const f = () => "a".repeat(${String(1024 * 1024 - 4096)});\n`,
  );
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, { sandbox: "none", leg: singleLeg(moduleRel), timeoutMs: 15_000 }),
  );
  expect(res.kind).toBe("ok");
  if (res.kind === "ok") {
    const entry = res.results[0]!;
    expect("output" in entry).toBe(true);
    if ("output" in entry) {
      expect(entry.output).toBe("a".repeat(1024 * 1024 - 4096));
    }
  }
}, 30_000);

test("a single frame with a wrong nonce followed by self-SIGKILL is tamper", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    [
      'import { writeSync } from "node:fs";',
      `writeSync(3, "${FORGED_NONCE} [{\\"id\\":\\"c1\\",\\"output\\":\\"FORGED\\"}]\\n");`,
      'process.kill(process.pid, "SIGKILL");',
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
  expectKind(res, "tamper");
}, 30_000);

test("a candidate that self-SIGKILLs after a partial line yields tamper", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    [
      'import { writeSync } from "node:fs";',
      'writeSync(3, "partial-without-newline");',
      'process.kill(process.pid, "SIGKILL");',
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
  expectKind(res, "tamper");
}, 30_000);

test("a candidate that writes a partial line then hangs is classified timeout", async () => {
  const sbx = await loadSandbox();
  const dirs = mkProbeDirs();
  const moduleRel = writeModule(
    dirs.treeDir,
    [
      'import { writeSync } from "node:fs";',
      'writeSync(3, "partial-before-hang");',
      "while (true) {}",
      "export const f = () => 0;",
      "",
    ].join("\n"),
  );
  const res = await sbx.runProbeLeg(
    probeOpts(dirs, {
      sandbox: "none",
      leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: null }] },
      timeoutMs: 600,
    }),
  );
  expect(res).toEqual({ kind: "timeout" });
}, 15_000);

test.skipIf(!HOST_SANDBOX)(
  "[sbx] a candidate exit hook cannot forge the frame under the real sandbox",
  async () => {
    const sbx = await loadSandbox();
    const kind = await sbx.requireSandbox();
    const dirs = mkProbeDirs();
    const moduleRel = writeModule(dirs.treeDir, FORGE_EXIT_MODULE);
    const res = await sbx.runProbeLeg(
      probeOpts(dirs, {
        sandbox: kind,
        leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: 1 }] },
        timeoutMs: 15_000,
      }),
    );
    expectNeverForged(res);
  },
  30_000,
);

test.skipIf(!HOST_SANDBOX)(
  "[sbx] the frame fd is unreadable and the frame file is invisible to the sandboxed candidate",
  async () => {
    const sbx = await loadSandbox();
    const kind = await sbx.requireSandbox();
    const dirs = mkProbeDirs();
    const moduleRel = writeModule(
      dirs.treeDir,
      [
        'import { readSync, readdirSync } from "node:fs";',
        'let fdRead = "readable";',
        "try {",
        "  const b = Buffer.alloc(64);",
        "  const n = readSync(3, b, 0, 64, 0);",
        '  fdRead = "read-" + String(n);',
        "} catch (err) {",
        "  fdRead = String(err && err.code ? err.code : err);",
        "}",
        "let names = [];",
        "try {",
        '  names = readdirSync(process.env.TMPDIR ?? "/tmp").map(String);',
        "} catch {",
        '  names = ["readdir-denied"];',
        "}",
        "export const f = () => ({ fdRead, names });",
        "",
      ].join("\n"),
    );
    const res = await sbx.runProbeLeg(
      probeOpts(dirs, {
        sandbox: kind,
        leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: null }] },
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
    const out = entry.output as { fdRead: string; names: string[] };
    expect(out.fdRead).toBe("EBADF");
    for (const name of out.names) {
      expect(name).not.toContain(".out");
    }
  },
  30_000,
);

test.skipIf(!HOST_SANDBOX)(
  "[sbx] a single forged-nonce frame followed by self-SIGKILL is tamper",
  async () => {
    const sbx = await loadSandbox();
    const kind = await sbx.requireSandbox();
    const dirs = mkProbeDirs();
    const moduleRel = writeModule(
      dirs.treeDir,
      [
        'import { writeSync } from "node:fs";',
        `writeSync(3, "${FORGED_NONCE} [{\\"id\\":\\"c1\\",\\"output\\":\\"FORGED\\"}]\\n");`,
        'process.kill(process.pid, "SIGKILL");',
        "export const f = (x) => ({ v: x });",
        "",
      ].join("\n"),
    );
    const res = await sbx.runProbeLeg(
      probeOpts(dirs, {
        sandbox: kind,
        leg: { module_rel: moduleRel, calls: [{ id: "c1", export: "f", input: 1 }] },
        timeoutMs: 15_000,
      }),
    );
    expectKind(res, "tamper");
  },
  30_000,
);
