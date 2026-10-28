import type { UpdateDeps } from "@src/commands/update/index.js";
import type {
  DaemonPort,
  GitPort,
  HostChild,
  InFlight,
  InstallGate,
  InstallPort,
  InstallResult,
  LogReader,
  LogSource,
  RuntimeState,
  ServiceManager,
} from "@src/commands/update/types.js";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);
export const REPO = "/srv/penumbra";
export const STORAGE = "/state";
export const HISTORY = `${STORAGE}/update-history.log`;

const IDLE: InFlight = { ok: true, dispatched: [], approved: 0 };

export const BUSY: InFlight = {
  ok: true,
  dispatched: [{ handoffId: "0123456789", agent: "claude", workerId: "w" }],
  approved: 0,
};

type InstallGateResult = { ok: true } | { ok: false; detail: string };

/** A scriptable host: git checkout, systemd units, daemon API and logs, all in memory. */
export class World {
  events: string[] = [];
  out: string[] = [];
  err: string[] = [];
  now = 1_000_000;
  head = SHA_A;
  branch: string | null = "main";
  refs = new Map<string, string>([["origin/main", SHA_B]]);
  /** "x>y" pairs where x is an ancestor of y. */
  ancestry = new Set<string>([`${SHA_A}>${SHA_B}`, `${SHA_A}>${SHA_C}`, `${SHA_B}>${SHA_C}`]);
  depsChanged = false;
  ci = "success";
  tracked: string[] = [];
  daemonActive = true;
  workerActive = true;
  daemonPid = 100;
  workerPid = 200;
  healthy = true;
  /** Whether a restart onto `sha` comes up healthy. */
  bootsOk: (sha: string) => boolean = () => true;
  inFlight: InFlight[] = [IDLE];
  scopes: string[] = [];
  children: string[] = [];
  /** When set, childProcesses() answers with this instead of deriving from `children`. */
  childSessions: HostChild[] | null = null;
  env: Record<string, string> = {};
  install: InstallResult = { ok: true, ran: true, detail: "installed" };
  gate: InstallGateResult = { ok: true };
  /** Runs during install.run(), e.g. to deliver a signal mid-install. */
  duringInstall: () => void = () => undefined;
  /** Runs on every in-flight poll, after the scripted answer is chosen. */
  onPoll: (poll: number) => void = () => undefined;
  polls = 0;
  exitCode: number | null = null;
  signalHandler: ((signal: string) => void) | null = null;
  cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/term.scope\n";
  parents = new Map<number, number>([[4242, 4000]]);
  bindsTo = new Map<string, string[]>();
  files = new Map<string, string>();
  logs = { daemon: "", worker: "" };
  manager: ServiceManager | null = this.systemd();
  managerReason: string | null = null;
  workingDirectory = REPO;
  serviceBun = "/usr/bin/bun";
  workerEnv: Record<string, string> = {};
  /** What the injected heavy-job lock probe answers (true: a flock(1) helper exists). */
  lockCrossProcess = true;
  /** Paths the heavy-job lock probe was asked about, in order. */
  lockProbes: string[] = [];

  state(): RuntimeState {
    const unit = (name: string, active: boolean, pid: number): RuntimeState["daemon"] => ({
      name,
      loaded: true,
      active,
      pid: active ? pid : null,
      workingDirectory: this.workingDirectory,
      argv: [this.serviceBun, `${this.workingDirectory}/packages/cli/bin/penumbra.ts`, "start"],
      environment: {},
    });
    return {
      daemon: unit("penumbra-daemon.service", this.daemonActive, this.daemonPid),
      worker: {
        ...unit("penumbra-worker.service", this.workerActive, this.workerPid),
        environment: { ...this.workerEnv },
      },
    };
  }

  private boot(which: "both" | "worker"): void {
    const ok = this.bootsOk(this.head);
    if (which === "both") {
      this.daemonPid += 1;
      this.daemonActive = ok;
      this.healthy = ok;
      if (ok) {
        this.logs.daemon +=
          '{"level":30,"msg":"job resource scopes enabled"}\n{"level":30,"port":1,"msg":"daemon started"}\n';
      }
    }
    this.workerPid += 1;
    this.workerActive = ok;
    if (ok) {
      this.logs.worker +=
        '{"level":30,"admit_min_gib":20,"msg":"job memory admission floor"}\n{"level":30,"msg":"agentchat worker started"}\n';
    }
  }

  systemd(kind: "launchd" | "systemd" = "systemd"): ServiceManager {
    const logSource = (which: "daemon" | "worker"): LogSource => ({ kind: "file", path: which });
    const manager: ServiceManager = {
      kind,
      daemonName: "penumbra-daemon.service",
      workerName: "penumbra-worker.service",
      canFreeze: kind === "systemd",
      state: () => Promise.resolve(this.state()),
      logSource: (which) => Promise.resolve(logSource(which)),
      jobScopes: () => Promise.resolve([...this.scopes]),
      bindsTo: (unit) => Promise.resolve(this.bindsTo.get(unit) ?? []),
      freeze: () => {
        this.events.push("freeze");
        this.workerActive = false;
        return Promise.resolve();
      },
      unfreeze: () => {
        this.events.push("unfreeze");
        this.boot("worker");
        return Promise.resolve();
      },
      restart: () => {
        this.events.push("restart");
        this.boot("both");
        return Promise.resolve();
      },
    };
    return manager;
  }

  deps(): UpdateDeps {
    const fail = (): never => {
      throw new Error("unexpected raw exec/http in a ports-faked test");
    };
    const deps: UpdateDeps = {
      exec: fail,
      http: fail,
      env: { ...this.env },
      home: "/home/op",
      cwd: REPO,
      cliDir: `${REPO}/packages/cli/src/commands/update`,
      bunPath: "/usr/bin/bun",
      onSignal: (handler) => {
        this.signalHandler = handler;
        return () => {
          this.signalHandler = null;
        };
      },
      exit: (code) => {
        this.exitCode = code;
      },
      out: (line) => this.out.push(line),
      err: (line) => this.err.push(line),
      heavyLockCrossProcess: (path) => {
        this.lockProbes.push(path);
        return this.lockCrossProcess;
      },
      clock: {
        now: () => this.now,
        sleep: (ms) => {
          this.now += ms;
          return Promise.resolve();
        },
      },
      fs: {
        readText: (path) => Promise.resolve(this.files.get(path) ?? null),
        appendText: (path, text) => {
          this.files.set(path, (this.files.get(path) ?? "") + text);
          if (path === HISTORY) {
            this.events.push(`history ${text.trim().split(" ").slice(1).join(" ")}`);
          }
          return Promise.resolve();
        },
        size: () => Promise.resolve(0),
        readFrom: () => Promise.resolve(""),
        realpath: (path) => Promise.resolve(path),
      },
      host: {
        platform: "linux",
        uid: 1000,
        pid: 4242,
        selfCgroup: () => Promise.resolve(this.cgroup),
        parentPid: (pid) => Promise.resolve(this.parents.get(pid) ?? 1),
        children: () => Promise.resolve([...this.children]),
        childProcesses: () =>
          Promise.resolve(
            this.childSessions ??
              this.children.map((line) => {
                const [pid, ...argv] = line.trim().split(/\s+/);
                return { pid: Number(pid), ageS: null, argv };
              }),
          ),
      },
      ports: {
        git: this.gitPort(),
        ci: { state: () => Promise.resolve(this.ci) },
        daemon: this.daemonPort(),
        logs: this.logsPort(),
        install: this.installPort(),
        manager: { manager: this.manager, reason: this.managerReason },
      },
    };
    return deps;
  }

  private gitPort(): GitPort {
    const port: GitPort = {
      topLevel: () => Promise.resolve(REPO),
      branch: () => Promise.resolve(this.branch),
      fetch: (ref) => {
        this.events.push(`fetch ${ref}`);
        return Promise.resolve();
      },
      resolve: (ref) => {
        if (/^[0-9a-f]{40}$/.test(ref)) return Promise.resolve(ref);
        if (/^[0-9a-f]{7,39}$/.test(ref)) {
          return Promise.resolve([SHA_A, SHA_B, SHA_C].find((sha) => sha.startsWith(ref)) ?? null);
        }
        return Promise.resolve(this.refs.get(ref) ?? null);
      },
      head: () => Promise.resolve(this.head),
      isAncestor: (a, b) => {
        const target = this.refs.get(b) ?? b;
        return Promise.resolve(a === target || this.ancestry.has(`${a}>${target}`));
      },
      log: () => Promise.resolve({ count: 2, lines: ["bbbbbbb feat: two", "ccccccc fix: one"] }),
      depsChanged: () => Promise.resolve(this.depsChanged),
      trackedChanges: () => Promise.resolve([...this.tracked]),
      fastForward: (to) => {
        this.events.push(`ff ${to.slice(0, 1)}`);
        if (!this.ancestry.has(`${this.head}>${to}`)) {
          return Promise.reject(
            new Error("git merge --ff-only failed: Not possible to fast-forward"),
          );
        }
        this.head = to;
        return Promise.resolve();
      },
      resetHard: (to) => {
        this.events.push(`reset ${to.slice(0, 1)}`);
        this.head = to;
        return Promise.resolve();
      },
    };
    return port;
  }

  private daemonPort(): DaemonPort {
    const port: DaemonPort = {
      health: () =>
        Promise.resolve({
          ok: this.healthy,
          port: 45787,
          detail: this.healthy ? "ok" : "connection refused",
        }),
      inFlight: () => {
        const answer =
          this.inFlight.length > 1 ? (this.inFlight.shift() ?? IDLE) : (this.inFlight[0] ?? IDLE);
        this.polls += 1;
        this.onPoll(this.polls);
        return Promise.resolve(answer);
      },
    };
    return port;
  }

  private logsPort(): LogReader {
    const port: LogReader = {
      cursor: (source) =>
        Promise.resolve({
          kind: "offset",
          value: source.kind === "file" ? this.logs[source.path as "daemon" | "worker"].length : 0,
        }),
      readSince: (source, cursor) =>
        Promise.resolve(
          source.kind === "file" && cursor.kind === "offset"
            ? this.logs[source.path as "daemon" | "worker"].slice(cursor.value)
            : "",
        ),
    };
    return port;
  }

  private installPort(): InstallPort {
    const port: InstallPort = {
      acquire: (): Promise<InstallGate> => {
        this.events.push("gate");
        const gate = this.gate;
        return Promise.resolve(
          gate.ok
            ? {
                ok: true,
                lease: {
                  release: (): Promise<void> => {
                    this.events.push("gate released");
                    return Promise.resolve();
                  },
                },
              }
            : gate,
        );
      },
      run: () => {
        this.events.push("install");
        const result = this.install;
        this.duringInstall();
        return Promise.resolve(result);
      },
    };
    return port;
  }

  /** Events that change the checkout or the runtime (fetch and gate bookkeeping excluded). */
  mutations(): string[] {
    return this.events.filter((event) => !event.startsWith("fetch") && !event.startsWith("gate"));
  }

  /** Delivers SIGINT/SIGTERM/SIGHUP to the running command. */
  signal(name: string): void {
    this.signalHandler?.(name);
  }

  json(): Record<string, unknown> {
    const line = this.out.at(-1);
    if (line === undefined) throw new Error("no stdout");
    return JSON.parse(line) as Record<string, unknown>;
  }
}
