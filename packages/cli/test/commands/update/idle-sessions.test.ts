import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterProgramNames,
  isAgentSession,
  loadAdapterProgramNames,
} from "@src/commands/update/agent-sessions.js";
import { parseEtime } from "@src/commands/update/deps.js";
import { probeIdle, waitForIdle } from "@src/commands/update/idle.js";
import { createUpdateContext, runUpdateCommand } from "@src/commands/update/index.js";
import { parseUpdateArgs } from "@src/commands/update/options.js";
import type { HostChild, UpdateContext } from "@src/commands/update/types.js";

import { BUSY, REPO, STORAGE, World } from "./_world.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seatConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-update-seats-"));
  dirs.push(dir);
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    [
      "agents:",
      "  - name: claude-acp",
      "    adapter: stdio-acp",
      "    options:",
      "      binary: claude-agent-acp",
      "  - name: codex-acp",
      "    adapter: stdio-acp",
      "    options:",
      "      binary: /Users/u/.local/bin/codex-acp",
      "  - name: runner-seat",
      "    adapter: stdio-acp",
      "    options:",
      "      binary: bun",
      "      args:",
      "        - /y/other.ts",
      "",
    ].join("\n"),
  );
  return path;
}

function mixedSeatConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-update-seats-"));
  dirs.push(dir);
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    [
      "agents:",
      "  - name: claude-acp",
      "    adapter: stdio-acp",
      "    options:",
      "      binary: claude-agent-acp",
      "  - name: claude-cli-seat",
      "    adapter: claude-cli",
      "    options:",
      "      command: /Users/u/.local/bin/claude",
      "",
    ].join("\n"),
  );
  return path;
}

function brokenSeatConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-update-seats-"));
  dirs.push(dir);
  const path = join(dir, "agentchat.yaml");
  writeFileSync(path, "agents:\n  - name: [unclosed\n");
  return path;
}

async function contextFor(world: World): Promise<UpdateContext> {
  const parsed = parseUpdateArgs([], world.env, REPO);
  if (parsed.ok !== true) throw new Error("bad test options");
  return await createUpdateContext(parsed.options, STORAGE, world.deps());
}

function session(pid: number, ageS: number | null, argv: string[]): HostChild {
  return { pid, ageS, argv };
}

const CLAUDE = ["node", "/Users/u/.local/bin/claude-agent-acp"];
const CODEX = ["node", "/Users/u/.local/bin/codex-acp"];

describe("agent session matcher", () => {
  const seats = [
    { executable: "claude-agent-acp" },
    { executable: "/Users/u/.local/bin/codex-acp" },
    { executable: "bun", args: ["/y/other.ts"] },
  ];
  const names = adapterProgramNames(seats);

  test("a runner spawning a seat executable matches", () => {
    expect(isAgentSession(CLAUDE, names)).toBe(true);
    expect(isAgentSession(CODEX, names)).toBe(true);
  });

  test("a runner spawning a different program does not match", () => {
    expect(isAgentSession(["bun", "/x/packages/agentchat/bin/foo.ts"], names)).toBe(false);
  });

  test("unrelated commands never match", () => {
    expect(isAgentSession(["git", "fetch"], names)).toBe(false);
    expect(isAgentSession(["bun", "test"], names)).toBe(false);
  });

  test("the match stops at the first argv entry that is not a generic runner", () => {
    expect(isAgentSession(["git", "fetch", "codex-acp"], names)).toBe(false);
    expect(isAgentSession(["sh", "-c", "claude-agent-acp"], names)).toBe(false);
  });

  test("loadAdapterProgramNames returns null when the config does not parse", () => {
    expect(
      loadAdapterProgramNames({ AGENTCHAT_CONFIG: brokenSeatConfig() }, "/home/op"),
    ).toBeNull();
  });

  test("CLI-spawn seat commands never contribute exempt program names", () => {
    const names = loadAdapterProgramNames({ AGENTCHAT_CONFIG: mixedSeatConfig() }, "/home/op");
    expect(names).not.toBeNull();
    expect(names?.has("claude")).toBe(false);
    expect(names?.has("claude-agent-acp")).toBe(true);
  });
});

describe("probeIdle with agent sessions under the worker", () => {
  test("ignores agent sessions aged past the grace when the daemon reports nothing in flight", async () => {
    const world = new World();
    world.env.AGENTCHAT_CONFIG = seatConfig();
    world.childSessions = [session(111, 300, CLAUDE), session(222, 300, CODEX)];

    const probe = await probeIdle(await contextFor(world), { requireDaemon: false });

    expect(probe.idle).toBe(true);
    expect(probe.reasons).toEqual([]);
    expect([...probe.ignoredSessions].sort()).toEqual(["111 claude-agent-acp", "222 codex-acp"]);
  });

  test("a young agent session still blocks", async () => {
    const world = new World();
    world.env.AGENTCHAT_CONFIG = seatConfig();
    world.childSessions = [session(111, 300, CLAUDE), session(222, 10, CODEX)];

    const probe = await probeIdle(await contextFor(world), { requireDaemon: false });

    expect(probe.idle).toBe(false);
    expect(probe.reasons.join("; ")).toContain("worker has child processes: 222");
    expect(probe.ignoredSessions).toEqual(["111 claude-agent-acp"]);
  });

  test("a non-session child blocks even beside old agent sessions", async () => {
    const world = new World();
    world.env.AGENTCHAT_CONFIG = seatConfig();
    world.childSessions = [
      session(111, 300, CLAUDE),
      session(333, 300, ["git", "merge-base", "HEAD", "origin/main"]),
    ];

    const probe = await probeIdle(await contextFor(world), { requireDaemon: false });

    expect(probe.idle).toBe(false);
    expect(probe.reasons.join("; ")).toContain("worker has child processes: 333 git");
    expect(probe.ignoredSessions).toEqual(["111 claude-agent-acp"]);
  });

  test("dispatched handoffs disable the exemption", async () => {
    const world = new World();
    world.env.AGENTCHAT_CONFIG = seatConfig();
    world.inFlight = [BUSY];
    world.childSessions = [session(111, 300, CLAUDE), session(222, 300, CODEX)];

    const probe = await probeIdle(await contextFor(world), { requireDaemon: false });

    expect(probe.idle).toBe(false);
    expect(probe.reasons.join("; ")).toContain("1 dispatched handoff(s)");
    expect(probe.reasons.join("; ")).toContain("worker has child processes");
    expect(probe.ignoredSessions).toEqual([]);
  });

  test("missing seat config keeps today's blocking behaviour", async () => {
    const world = new World();
    world.childSessions = [session(111, 300, CLAUDE)];

    const probe = await probeIdle(await contextFor(world), { requireDaemon: false });

    expect(probe.idle).toBe(false);
    expect(probe.reasons.join("; ")).toContain("worker has child processes: 111 node");
    expect(probe.ignoredSessions).toEqual([]);
  });

  test("an unloadable seat config keeps today's blocking behaviour", async () => {
    const world = new World();
    world.env.AGENTCHAT_CONFIG = brokenSeatConfig();
    world.childSessions = [session(111, 300, CLAUDE)];

    const probe = await probeIdle(await contextFor(world), { requireDaemon: false });

    expect(probe.idle).toBe(false);
    expect(probe.reasons.join("; ")).toContain("worker has child processes: 111 node");
    expect(probe.ignoredSessions).toEqual([]);
  });

  test("a failed in-flight listing keeps agent-session children blocking", async () => {
    const world = new World();
    world.env.AGENTCHAT_CONFIG = seatConfig();
    world.inFlight = [{ ok: false, error: "connection refused" }];
    world.childSessions = [session(111, 300, CLAUDE)];

    const probe = await probeIdle(await contextFor(world), { requireDaemon: false });

    expect(probe.idle).toBe(false);
    expect(probe.reasons.join("; ")).toContain("worker has child processes: 111 node");
    expect(probe.ignoredSessions).toEqual([]);
  });

  test("a CLI-spawn claude child blocks while the warm ACP session is ignored", async () => {
    const world = new World();
    world.env.AGENTCHAT_CONFIG = mixedSeatConfig();
    world.childSessions = [
      session(111, 300, CLAUDE),
      session(444, 300, ["/Users/u/.local/bin/claude", "-p"]),
    ];

    const probe = await probeIdle(await contextFor(world), { requireDaemon: false });

    expect(probe.idle).toBe(false);
    expect(probe.reasons.join("; ")).toContain("worker has child processes: 444");
    expect(probe.ignoredSessions).toEqual(["111 claude-agent-acp"]);
  });

  test("unknown age keeps an agent-session child blocking", async () => {
    const world = new World();
    world.env.AGENTCHAT_CONFIG = seatConfig();
    world.childSessions = [session(111, null, CLAUDE)];

    const probe = await probeIdle(await contextFor(world), { requireDaemon: false });

    expect(probe.idle).toBe(false);
    expect(probe.reasons.join("; ")).toContain("worker has child processes: 111 node");
    expect(probe.ignoredSessions).toEqual([]);
  });
});

describe("waitForIdle with ignored agent sessions", () => {
  test("says the ignoring line once across polls and reports the sessions in the result", async () => {
    const world = new World();
    world.env.AGENTCHAT_CONFIG = seatConfig();
    world.childSessions = [session(111, 300, CLAUDE), session(222, 300, CODEX)];
    world.scopes = ["penumbra-job-1"];
    world.onPoll = (poll): void => {
      if (poll >= 3) world.scopes = [];
    };

    const res = await waitForIdle(await contextFor(world), {
      budgetS: 120,
      requireDaemon: false,
      pollMs: 10,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect([...res.ignoredSessions].sort()).toEqual(["111 claude-agent-acp", "222 codex-acp"]);
    }
    const said = world.out.filter((line) => line.includes("ignoring 2 idle agent session(s)"));
    expect(said.length).toBe(1);
  });

  test("--apply --json carries the ignored sessions", async () => {
    const world = new World();
    world.env.AGENTCHAT_CONFIG = seatConfig();
    world.childSessions = [session(111, 300, CLAUDE), session(222, 300, CODEX)];

    expect(await runUpdateCommand(["--apply", "--json"], STORAGE, world.deps())).toBe(0);

    expect(world.json()).toMatchObject({
      mode: "apply",
      outcome: "updated",
      ignored_sessions: ["111 claude-agent-acp", "222 codex-acp"],
    });
  });
});

describe("ps etime parsing", () => {
  test("parses [[dd-]hh:]mm:ss into seconds", () => {
    expect(parseEtime("05:07")).toBe(307);
    expect(parseEtime("01:02:03")).toBe(3723);
    expect(parseEtime("2-00:00:01")).toBe(172801);
  });

  test("returns null for unparseable values", () => {
    expect(parseEtime("")).toBeNull();
    expect(parseEtime("elapsed")).toBeNull();
  });
});
