import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { handleAgentchatReload } from "@src/worker/config-reload.js";
import {
  type ControlListenerClient,
  runWorkerControlListener,
  type WorkerControlEvent,
} from "@src/worker/control-listener.js";
import { resolveDispatchCwd, UnknownProjectError } from "@src/worker/project-cwd.js";
import { type RegistryReloadResult, WorkerProjectRegistry } from "@src/worker/project-registry.js";
import { createWorkerWorktreeManager } from "@src/worker/worktree-manager.js";

interface RecordedLogCall {
  obj: Record<string, unknown>;
  msg: string;
}

function makeRecordingLog(): {
  calls: { info: RecordedLogCall[]; warn: RecordedLogCall[]; error: RecordedLogCall[] };
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
} {
  const calls = {
    info: [] as RecordedLogCall[],
    warn: [] as RecordedLogCall[],
    error: [] as RecordedLogCall[],
  };
  return {
    calls,
    info: (obj, msg): void => {
      calls.info.push({ obj, msg });
    },
    warn: (obj, msg): void => {
      calls.warn.push({ obj, msg });
    },
    error: (obj, msg): void => {
      calls.error.push({ obj, msg });
    },
  };
}

const silentLog = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function makeProjectsYaml(dir: string): { yamlPath: string; alphaRoot: string; projXRoot: string } {
  const alphaRoot = path.join(dir, "alpha");
  const projXRoot = path.join(dir, "proj-x");
  fs.mkdirSync(alphaRoot);
  fs.mkdirSync(projXRoot);
  const yamlPath = path.join(dir, "projects.yaml");
  fs.writeFileSync(
    yamlPath,
    ["projects:", "  - project_id: alpha", `    root_path: ${alphaRoot}`, ""].join("\n"),
  );
  return { yamlPath, alphaRoot, projXRoot };
}

async function deliverControlEvent(
  event: WorkerControlEvent,
  onConfigReload: () => void,
): Promise<void> {
  const abort = new AbortController();
  async function* subscribeWorkerControl(): AsyncGenerator<WorkerControlEvent, void, undefined> {
    await Promise.resolve();
    yield event;
    abort.abort();
  }
  const client: ControlListenerClient = {
    sendProbeAck: () => Promise.resolve(),
    subscribeWorkerControl,
  };
  await runWorkerControlListener({
    client,
    dispatcher: { cancel: () => undefined },
    signal: abort.signal,
    log: silentLog,
    sleep: () => Promise.resolve(),
    onConfigReload,
  });
}

// Builds deps for handleAgentchatReload backed by the real registry holder.
// registry.reload is wrapped so the test can await the promise the handler
// fire-and-forgets and observe ordering relative to the prewarm refresh.
function makeReloadDeps(input: {
  projectRegistry: WorkerProjectRegistry;
  events: string[];
  log: ReturnType<typeof makeRecordingLog>;
}): {
  deps: Parameters<typeof handleAgentchatReload>[0];
  settled: () => Promise<RegistryReloadResult>;
} {
  const config = { agents: [{ name: "alpha-cli" }] };
  let lastReload: Promise<RegistryReloadResult> = Promise.resolve({ ok: true, count: 0 });
  const deps = {
    loadConfig: (): { previous: typeof config; next: typeof config } => {
      input.events.push("load-config");
      return { previous: config, next: config };
    },
    invalidateWarmPools: (): void => {
      input.events.push("invalidate-warm-pools");
    },
    refreshPrewarm: (): void => {
      input.events.push("refresh-prewarm");
    },
    projectRegistry: {
      reload: (): Promise<RegistryReloadResult> => {
        const p = input.projectRegistry.reload();
        void p.then((result) => {
          input.events.push(`registry:${result.ok ? "ok" : "failed"}`);
        });
        lastReload = p;
        return p;
      },
    },
    log: input.log,
  };
  return { deps, settled: () => lastReload };
}

test("agentchat_reload swaps the worker project registry for dispatch cwd and worktree roots", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-registry-reload-"));
  try {
    const { yamlPath, alphaRoot, projXRoot } = makeProjectsYaml(dir);

    const projectRegistry = new WorkerProjectRegistry(yamlPath);
    const worktreeManager = createWorkerWorktreeManager({
      rootDir: path.join(dir, "worktrees"),
      mainRepoDir: dir,
      projectRegistry,
    });

    expect(projectRegistry.get("alpha")?.root_path).toBe(alphaRoot);
    expect(() =>
      resolveDispatchCwd({
        project_id: "proj-x",
        defaultCwd: dir,
        projectRegistry,
      }),
    ).toThrow(UnknownProjectError);
    expect(worktreeManager.projectRootFor("proj-x")).toBeUndefined();

    fs.appendFileSync(yamlPath, `  - project_id: proj-x\n    root_path: ${projXRoot}\n`);

    const events: string[] = [];
    const log = makeRecordingLog();
    const { deps, settled } = makeReloadDeps({ projectRegistry, events, log });
    await deliverControlEvent({ type: "agentchat_reload" }, () => {
      handleAgentchatReload(deps);
    });
    const result = await settled();

    expect(result).toEqual({ ok: true, count: 2 });
    // Prewarm refresh is deferred until the registry reload resolves.
    expect(events).toEqual([
      "load-config",
      "invalidate-warm-pools",
      "registry:ok",
      "refresh-prewarm",
    ]);
    expect(
      resolveDispatchCwd({
        project_id: "proj-x",
        defaultCwd: dir,
        projectRegistry,
      }),
    ).toBe(projXRoot);
    expect(worktreeManager.projectRootFor("proj-x")).toBe(projXRoot);
    expect(log.calls.info.some((c) => c.msg === "project-registry-reloaded-from-control-bus")).toBe(
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing projects.yaml fails the reload, keeps the old registry, and still refreshes prewarm", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-registry-reload-"));
  try {
    const { yamlPath, alphaRoot } = makeProjectsYaml(dir);
    const warns: string[] = [];
    const projectRegistry = new WorkerProjectRegistry(yamlPath, (msg) => {
      warns.push(msg);
    });

    fs.rmSync(yamlPath);

    const events: string[] = [];
    const log = makeRecordingLog();
    const { deps, settled } = makeReloadDeps({ projectRegistry, events, log });
    await deliverControlEvent({ type: "agentchat_reload" }, () => {
      handleAgentchatReload(deps);
    });
    const result = await settled();

    expect(result.ok).toBe(false);
    expect(projectRegistry.get("alpha")?.root_path).toBe(alphaRoot);
    expect(projectRegistry.size).toBe(1);
    expect(
      log.calls.warn.some(
        (c) => c.msg === "project registry reload failed; keeping previous registry",
      ),
    ).toBe(true);
    expect(warns.length).toBe(1);
    expect(events).toEqual([
      "load-config",
      "invalidate-warm-pools",
      "registry:failed",
      "refresh-prewarm",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reload reports failure and keeps the previous registry when the file goes missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-registry-reload-"));
  try {
    const { yamlPath, alphaRoot } = makeProjectsYaml(dir);
    const warns: string[] = [];
    const projectRegistry = new WorkerProjectRegistry(yamlPath, (msg) => {
      warns.push(msg);
    });

    fs.rmSync(yamlPath);

    const result = await projectRegistry.reload();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ENOENT");
    expect(projectRegistry.get("alpha")?.root_path).toBe(alphaRoot);
    expect(projectRegistry.size).toBe(1);
    expect(warns.length).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reload reports failure and keeps serving the previous registry when the yaml becomes malformed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-registry-reload-"));
  try {
    const { yamlPath, alphaRoot } = makeProjectsYaml(dir);
    const warns: string[] = [];
    const projectRegistry = new WorkerProjectRegistry(yamlPath, (msg) => {
      warns.push(msg);
    });

    fs.writeFileSync(yamlPath, "projects:\n  - project_id: broken\n");

    const result = await projectRegistry.reload();
    expect(result.ok).toBe(false);
    expect(projectRegistry.get("alpha")?.root_path).toBe(alphaRoot);
    expect(projectRegistry.size).toBe(1);
    expect(warns.length).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
