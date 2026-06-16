import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHooksInstallClaude,
  runHooksUninstallClaude,
  runHooksInstallGeminiOtel,
  runHooksUninstallGeminiOtel,
  runHooksInstallCodexOtel,
  runHooksUninstallCodexOtel,
  runHooksInstallClaudeOtel,
  runHooksUninstallClaudeOtel,
  runHooksInstallClaudeMemory,
  runHooksUninstallClaudeMemory,
  runHooksInstallClaudeMd,
  runHooksUninstallClaudeMd,
} from "../../src/commands/hooks.js";

function tmpClaudeDir(initial?: any): string {
  const root = mkdtempSync(join(tmpdir(), "penumbra-hooks-"));
  const claudeDir = join(root, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  if (initial !== undefined)
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(initial));
  return claudeDir;
}

describe("hooks install --claude", () => {
  it("installs penumbra statusline when no statusLine is configured", async () => {
    const claudeDir = tmpClaudeDir({});
    const scriptDir = mkdtempSync(join(tmpdir(), "penumbra-bin-"));
    const result = await runHooksInstallClaude({ claudeDir, scriptDir, force: false });
    expect(result.installed).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.statusLine.command).toContain("penumbra-claude-statusline");
    expect(existsSync(join(scriptDir, "penumbra-claude-statusline"))).toBe(true);
  });

  it("is idempotent when penumbra is already installed", async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), "penumbra-bin-"));
    const claudeDir = tmpClaudeDir({
      statusLine: { command: join(scriptDir, "penumbra-claude-statusline") },
    });
    const result = await runHooksInstallClaude({ claudeDir, scriptDir, force: false });
    expect(result.installed).toBe(false);
    expect(result.idempotent).toBe(true);
  });

  it("refuses to overwrite a third-party statusLine without --force", async () => {
    const claudeDir = tmpClaudeDir({ statusLine: { command: "/some/other/script.sh" } });
    const scriptDir = mkdtempSync(join(tmpdir(), "penumbra-bin-"));
    await expect(runHooksInstallClaude({ claudeDir, scriptDir, force: false })).rejects.toThrow(
      /Refusing to overwrite|--force/,
    );
  });

  it("with --force, backs up the existing statusLine and replaces it", async () => {
    const claudeDir = tmpClaudeDir({ statusLine: { command: "/oi/script.sh" } });
    const scriptDir = mkdtempSync(join(tmpdir(), "penumbra-bin-"));
    const result = await runHooksInstallClaude({ claudeDir, scriptDir, force: true });
    expect(result.installed).toBe(true);
    expect(result.backupPath).toBeDefined();
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.statusLine.command).toContain("penumbra-claude-statusline");
    expect(existsSync(result.backupPath!)).toBe(true);
  });
});

describe("hooks uninstall --claude", () => {
  it("removes penumbra statusLine but does not touch backup file", async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), "penumbra-bin-"));
    const claudeDir = tmpClaudeDir({
      statusLine: { command: join(scriptDir, "penumbra-claude-statusline") },
    });
    const r = await runHooksUninstallClaude({ claudeDir, scriptDir });
    expect(r.removed).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.statusLine).toBeUndefined();
  });
});

function makeFakeHome(): { home: string; geminiDir: string; portFile: string } {
  const home = mkdtempSync(join(tmpdir(), "penumbra-hooks-"));
  const geminiDir = join(home, ".gemini");
  mkdirSync(geminiDir, { recursive: true });
  const portFile = join(home, "penumbra-port");
  writeFileSync(portFile, "51390");
  return { home, geminiDir, portFile };
}

describe("runHooksInstallGeminiOtel", () => {
  it("writes telemetry block into ~/.gemini/settings.json with the daemon port", async () => {
    const { geminiDir, portFile } = makeFakeHome();
    const r = await runHooksInstallGeminiOtel({ geminiDir, portFile });
    expect(r.installed).toBe(true);
    const settings = JSON.parse(readFileSync(join(geminiDir, "settings.json"), "utf8"));
    expect(settings.telemetry).toMatchObject({
      enabled: true,
      target: "local",
      otlpProtocol: "http",
      otlpEndpoint: "http://localhost:51390",
    });
  });

  it("preserves existing settings.json keys", async () => {
    const { geminiDir, portFile } = makeFakeHome();
    writeFileSync(
      join(geminiDir, "settings.json"),
      JSON.stringify({ theme: "Dark", selectedAuthType: "oauth-personal" }, null, 2),
    );
    await runHooksInstallGeminiOtel({ geminiDir, portFile });
    const settings = JSON.parse(readFileSync(join(geminiDir, "settings.json"), "utf8"));
    expect(settings.theme).toBe("Dark");
    expect(settings.selectedAuthType).toBe("oauth-personal");
    expect(settings.telemetry?.otlpEndpoint).toBe("http://localhost:51390");
  });

  it("is idempotent when settings already match", async () => {
    const { geminiDir, portFile } = makeFakeHome();
    await runHooksInstallGeminiOtel({ geminiDir, portFile });
    const r2 = await runHooksInstallGeminiOtel({ geminiDir, portFile });
    expect(r2.idempotent).toBe(true);
    expect(r2.installed).toBe(false);
  });

  it("throws when port file is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "penumbra-hooks-"));
    const geminiDir = join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    await expect(
      runHooksInstallGeminiOtel({ geminiDir, portFile: join(home, "missing") }),
    ).rejects.toThrow(/port/i);
  });
});

describe("runHooksUninstallGeminiOtel", () => {
  it("removes the telemetry block we wrote", async () => {
    const { geminiDir, portFile } = makeFakeHome();
    await runHooksInstallGeminiOtel({ geminiDir, portFile });
    const r = await runHooksUninstallGeminiOtel({ geminiDir });
    expect(r.removed).toBe(true);
    const settings = JSON.parse(readFileSync(join(geminiDir, "settings.json"), "utf8"));
    expect(settings.telemetry).toBeUndefined();
  });

  it("returns removed=false when no telemetry block exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "penumbra-hooks-"));
    const geminiDir = join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(join(geminiDir, "settings.json"), JSON.stringify({ theme: "Dark" }));
    const r = await runHooksUninstallGeminiOtel({ geminiDir });
    expect(r.removed).toBe(false);
  });
});

function makeFakeCodexHome(): { home: string; codexDir: string; portFile: string } {
  const home = mkdtempSync(join(tmpdir(), "penumbra-hooks-codex-"));
  const codexDir = join(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const portFile = join(home, "penumbra-port");
  writeFileSync(portFile, "51390");
  return { home, codexDir, portFile };
}

describe("runHooksInstallCodexOtel", () => {
  it("writes a managed [otel] block with correct endpoint and protocol=binary", async () => {
    const { codexDir, portFile } = makeFakeCodexHome();
    const r = await runHooksInstallCodexOtel({ codexDir, portFile });
    expect(r.installed).toBe(true);
    expect(r.endpoint).toBe("http://localhost:51390/v1/logs");
    const config = readFileSync(join(codexDir, "config.toml"), "utf8");
    expect(config).toContain("# penumbra: managed [otel] block");
    expect(config).toContain("# penumbra: end managed [otel] block");
    expect(config).toContain("[otel]");
    expect(config).toContain(`endpoint = "http://localhost:51390/v1/logs"`);
    expect(config).toContain('protocol = "binary"');
    expect(config).toContain('environment = "penumbra"');
  });

  it("preserves existing config.toml content above the managed block", async () => {
    const { codexDir, portFile } = makeFakeCodexHome();
    const existing = `[user]\nname = "test"\n\n[mcp_servers.foo]\ncommand = "echo"\n`;
    writeFileSync(join(codexDir, "config.toml"), existing);
    await runHooksInstallCodexOtel({ codexDir, portFile });
    const config = readFileSync(join(codexDir, "config.toml"), "utf8");
    expect(config).toContain("[user]");
    expect(config).toContain('name = "test"');
    expect(config).toContain("[mcp_servers.foo]");
    expect(config).toContain("# penumbra: managed [otel] block");
  });

  it("is idempotent on second invocation with the same port", async () => {
    const { codexDir, portFile } = makeFakeCodexHome();
    await runHooksInstallCodexOtel({ codexDir, portFile });
    const r2 = await runHooksInstallCodexOtel({ codexDir, portFile });
    expect(r2.idempotent).toBe(true);
    expect(r2.installed).toBe(false);
  });

  it("rewrites the managed block when the port changes", async () => {
    const { codexDir, portFile } = makeFakeCodexHome();
    await runHooksInstallCodexOtel({ codexDir, portFile });
    writeFileSync(portFile, "60000");
    const r2 = await runHooksInstallCodexOtel({ codexDir, portFile });
    expect(r2.installed).toBe(true);
    expect(r2.idempotent).not.toBe(true);
    const config = readFileSync(join(codexDir, "config.toml"), "utf8");
    expect(config).toContain("http://localhost:60000/v1/logs");
    expect(config).not.toContain("http://localhost:51390/v1/logs");
    const headerCount = (config.match(/# penumbra: managed \[otel\] block/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it("throws when port file is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "penumbra-hooks-codex-"));
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    await expect(
      runHooksInstallCodexOtel({ codexDir, portFile: join(home, "missing") }),
    ).rejects.toThrow(/port/i);
  });
});

describe("runHooksUninstallCodexOtel", () => {
  it("removes the managed block but preserves other config", async () => {
    const { codexDir, portFile } = makeFakeCodexHome();
    const existing = `[user]\nname = "test"\n`;
    writeFileSync(join(codexDir, "config.toml"), existing);
    await runHooksInstallCodexOtel({ codexDir, portFile });
    const r = await runHooksUninstallCodexOtel({ codexDir });
    expect(r.removed).toBe(true);
    const config = readFileSync(join(codexDir, "config.toml"), "utf8");
    expect(config).toContain("[user]");
    expect(config).not.toContain("# penumbra: managed [otel] block");
    expect(config).not.toContain("[otel]");
  });

  it("returns removed=false when no managed block exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "penumbra-hooks-codex-"));
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "config.toml"), '[user]\nname = "test"\n');
    const r = await runHooksUninstallCodexOtel({ codexDir });
    expect(r.removed).toBe(false);
  });

  it("returns removed=false when config.toml does not exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "penumbra-hooks-codex-"));
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const r = await runHooksUninstallCodexOtel({ codexDir });
    expect(r.removed).toBe(false);
  });
});

function makeFakeClaudeOtelHome(): { home: string; claudeDir: string; portFile: string } {
  const home = mkdtempSync(join(tmpdir(), "penumbra-hooks-claudeotel-"));
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const portFile = join(home, "penumbra-port");
  writeFileSync(portFile, "51390");
  return { home, claudeDir, portFile };
}

describe("runHooksInstallClaudeOtel", () => {
  it("writes OTEL_* env keys to settings.json env block", async () => {
    const { claudeDir, portFile } = makeFakeClaudeOtelHome();
    const r = await runHooksInstallClaudeOtel({ claudeDir, portFile });
    expect(r.installed).toBe(true);
    expect(r.endpoint).toBe("http://localhost:51390");
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:51390",
    });
  });

  it("preserves existing settings.json keys (e.g. statusLine from --claude)", async () => {
    const { claudeDir, portFile } = makeFakeClaudeOtelHome();
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          statusLine: { type: "command", command: "/some/path/penumbra-claude-statusline" },
          theme: "Dark",
        },
        null,
        2,
      ),
    );
    await runHooksInstallClaudeOtel({ claudeDir, portFile });
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.statusLine).toMatchObject({ type: "command" });
    expect(settings.theme).toBe("Dark");
    expect(settings.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:51390");
  });

  it("preserves user env vars unrelated to OTEL_*", async () => {
    const { claudeDir, portFile } = makeFakeClaudeOtelHome();
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          env: { MY_API_KEY: "secret-xyz", CUSTOM_VAR: "foo" },
        },
        null,
        2,
      ),
    );
    await runHooksInstallClaudeOtel({ claudeDir, portFile });
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.env.MY_API_KEY).toBe("secret-xyz");
    expect(settings.env.CUSTOM_VAR).toBe("foo");
    expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:51390");
  });

  it("is idempotent when env keys already match", async () => {
    const { claudeDir, portFile } = makeFakeClaudeOtelHome();
    await runHooksInstallClaudeOtel({ claudeDir, portFile });
    const r2 = await runHooksInstallClaudeOtel({ claudeDir, portFile });
    expect(r2.idempotent).toBe(true);
    expect(r2.installed).toBe(false);
  });

  it("rewrites the env keys when port changes", async () => {
    const { claudeDir, portFile } = makeFakeClaudeOtelHome();
    await runHooksInstallClaudeOtel({ claudeDir, portFile });
    writeFileSync(portFile, "60000");
    const r2 = await runHooksInstallClaudeOtel({ claudeDir, portFile });
    expect(r2.installed).toBe(true);
    expect(r2.idempotent).not.toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:60000");
  });

  it("throws when port file is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "penumbra-hooks-claudeotel-"));
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    await expect(
      runHooksInstallClaudeOtel({ claudeDir, portFile: join(home, "missing") }),
    ).rejects.toThrow(/port/i);
  });
});

describe("runHooksUninstallClaudeOtel", () => {
  it("removes only the OTEL_* keys, preserves other env vars", async () => {
    const { claudeDir, portFile } = makeFakeClaudeOtelHome();
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          env: { MY_API_KEY: "secret-xyz" },
        },
        null,
        2,
      ),
    );
    await runHooksInstallClaudeOtel({ claudeDir, portFile });
    const r = await runHooksUninstallClaudeOtel({ claudeDir });
    expect(r.removed).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.env.MY_API_KEY).toBe("secret-xyz");
    expect(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it("drops the env block entirely if it becomes empty after OTEL_* removal", async () => {
    const { claudeDir, portFile } = makeFakeClaudeOtelHome();
    await runHooksInstallClaudeOtel({ claudeDir, portFile });
    const r = await runHooksUninstallClaudeOtel({ claudeDir });
    expect(r.removed).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.env).toBeUndefined();
  });

  it("preserves statusLine when removing OTEL_* env keys", async () => {
    const { claudeDir, portFile } = makeFakeClaudeOtelHome();
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          statusLine: { type: "command", command: "/some/path" },
        },
        null,
        2,
      ),
    );
    await runHooksInstallClaudeOtel({ claudeDir, portFile });
    await runHooksUninstallClaudeOtel({ claudeDir });
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.statusLine).toMatchObject({ type: "command" });
  });

  it("returns removed=false when no OTEL_* keys exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "penumbra-hooks-claudeotel-"));
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ theme: "Dark" }));
    const r = await runHooksUninstallClaudeOtel({ claudeDir });
    expect(r.removed).toBe(false);
  });
});

describe("hooks install --claude-memory", () => {
  const FAKE_BIN = "/opt/penumbra/bin/penumbra.ts";
  const FAKE_ROOT = "/opt/penumbra/storage";

  it("installs hooks for the mapped events when settings.json is empty", async () => {
    const claudeDir = tmpClaudeDir({});
    const r = await runHooksInstallClaudeMemory({
      claudeDir,
      storageRoot: FAKE_ROOT,
      binPath: FAKE_BIN,
      skipDaemonCheck: true,
    });
    expect(r.installed).toBe(true);
    expect(r.events).toEqual([
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "SessionStart",
      "PreCompact",
      "Stop",
    ]);

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    for (const ev of [
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "SessionStart",
      "PreCompact",
      "Stop",
    ]) {
      const cmds = settings.hooks[ev].flatMap((e: any) => e.hooks.map((h: any) => h.command));
      expect(cmds.some((c: string) => c.includes("penumbra.ts hook claude-code"))).toBe(true);
      expect(cmds.some((c: string) => c.includes(`PENUMBRA_STORAGE_ROOT=${FAKE_ROOT}`))).toBe(true);
    }
  });

  it("is idempotent on second run with the same args", async () => {
    const claudeDir = tmpClaudeDir({});
    await runHooksInstallClaudeMemory({
      claudeDir,
      storageRoot: FAKE_ROOT,
      binPath: FAKE_BIN,
      skipDaemonCheck: true,
    });
    const r = await runHooksInstallClaudeMemory({
      claudeDir,
      storageRoot: FAKE_ROOT,
      binPath: FAKE_BIN,
      skipDaemonCheck: true,
    });
    expect(r.installed).toBe(false);
    expect(r.idempotent).toBe(true);
  });

  it("updates a stale penumbra hook in place without touching other tools' hooks", async () => {
    const claudeDir = tmpClaudeDir({
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "~/.claude/hooks/some-other-tool.sh" }],
          },
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command:
                  "PENUMBRA_STORAGE_ROOT=/tmp/stale bun /old/path/penumbra.ts hook claude-code",
              },
            ],
          },
        ],
      },
    });
    const r = await runHooksInstallClaudeMemory({
      claudeDir,
      storageRoot: FAKE_ROOT,
      binPath: FAKE_BIN,
      skipDaemonCheck: true,
    });
    expect(r.installed).toBe(true);

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    const ups = settings.hooks.UserPromptSubmit;
    // The other tool's entry is preserved.
    expect(ups[0].hooks[0].command).toBe("~/.claude/hooks/some-other-tool.sh");
    // The penumbra entry was updated in place — no duplicate appended.
    const penumbraCmds = ups
      .flatMap((e: any) => e.hooks.map((h: any) => h.command))
      .filter((c: string) => c.includes("penumbra.ts hook claude-code"));
    expect(penumbraCmds).toHaveLength(1);
    expect(penumbraCmds[0]).toContain(`PENUMBRA_STORAGE_ROOT=${FAKE_ROOT}`);
    expect(penumbraCmds[0]).toContain(FAKE_BIN);
  });

  it("throws when daemon port file is missing and skipDaemonCheck is false", async () => {
    const claudeDir = tmpClaudeDir({});
    const root = mkdtempSync(join(tmpdir(), "penumbra-no-daemon-"));
    await expect(
      runHooksInstallClaudeMemory({ claudeDir, storageRoot: root, binPath: FAKE_BIN }),
    ).rejects.toThrow(/daemon port file/);
  });
});

describe("hooks uninstall --claude-memory", () => {
  const FAKE_BIN = "/opt/penumbra/bin/penumbra.ts";
  const FAKE_ROOT = "/opt/penumbra/storage";

  it("removes only penumbra hooks and preserves other tools' entries", async () => {
    const claudeDir = tmpClaudeDir({
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "~/.claude/hooks/some-other-tool.sh" }],
          },
        ],
      },
    });
    await runHooksInstallClaudeMemory({
      claudeDir,
      storageRoot: FAKE_ROOT,
      binPath: FAKE_BIN,
      skipDaemonCheck: true,
    });
    const r = await runHooksUninstallClaudeMemory({ claudeDir });
    expect(r.removed).toBe(true);
    expect(r.events).toContain("UserPromptSubmit");

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    const ups = settings.hooks.UserPromptSubmit;
    // Other-tool entry remains; no penumbra commands left.
    expect(
      ups
        .flatMap((e: any) => e.hooks.map((h: any) => h.command))
        .filter((c: string) => c.includes("penumbra.ts hook claude-code")),
    ).toHaveLength(0);
    expect(ups[0].hooks[0].command).toBe("~/.claude/hooks/some-other-tool.sh");
  });

  it("returns removed=false when no penumbra hooks exist", async () => {
    const claudeDir = tmpClaudeDir({
      hooks: {
        UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "echo other" }] }],
      },
    });
    const r = await runHooksUninstallClaudeMemory({ claudeDir });
    expect(r.removed).toBe(false);
    expect(r.events).toEqual([]);
  });
});

describe("PENUMBRA_HOOK_EVENTS", () => {
  it("includes SessionStart, PreCompact, Stop", async () => {
    const { PENUMBRA_HOOK_EVENTS } = await import("../../src/commands/hooks.js");
    expect(PENUMBRA_HOOK_EVENTS).toContain("SessionStart");
    expect(PENUMBRA_HOOK_EVENTS).toContain("PreCompact");
    expect(PENUMBRA_HOOK_EVENTS).toContain("Stop");
  });
});

describe("hooks install --claude-md (dispatch-discipline managed block)", () => {
  const MD = "CLAUDE.md";

  it("creates CLAUDE.md with the managed block when absent", async () => {
    const claudeDir = tmpClaudeDir();
    const r = await runHooksInstallClaudeMd({ claudeDir });
    expect(r.installed).toBe(true);
    const body = readFileSync(join(claudeDir, MD), "utf8");
    expect(body).toContain("managed [dispatch-discipline] block");
    expect(body).toContain("Dispatch discipline (penumbra)");
    expect(body).toContain("ultracode");
    expect(body).toContain("SOLO-OK");
  });

  it("is idempotent: a second run is a no-op (byte-identical)", async () => {
    const claudeDir = tmpClaudeDir();
    await runHooksInstallClaudeMd({ claudeDir });
    const first = readFileSync(join(claudeDir, MD), "utf8");
    const r2 = await runHooksInstallClaudeMd({ claudeDir });
    expect(r2.installed).toBe(false);
    expect(r2.idempotent).toBe(true);
    const second = readFileSync(join(claudeDir, MD), "utf8");
    expect(second).toBe(first);
  });

  it("preserves text outside the markers (non-clobbering)", async () => {
    const claudeDir = tmpClaudeDir();
    const userText = "# My personal notes\n\nDo not delete this.\n";
    writeFileSync(join(claudeDir, MD), userText);
    await runHooksInstallClaudeMd({ claudeDir });
    const body = readFileSync(join(claudeDir, MD), "utf8");
    expect(body).toContain("# My personal notes");
    expect(body).toContain("Do not delete this.");
    expect(body).toContain("managed [dispatch-discipline] block");
    // user text appears before the managed block
    expect(body.indexOf("My personal notes")).toBeLessThan(
      body.indexOf("managed [dispatch-discipline] block"),
    );
  });

  it("replaces the block in place rather than appending a second copy", async () => {
    const claudeDir = tmpClaudeDir();
    // Seed a stale block (different version marker) so install rewrites it.
    const stale = [
      "<!-- penumbra: managed [dispatch-discipline] block — do not edit between markers -->",
      "<!-- v0 -->",
      "stale body",
      "<!-- penumbra: end managed [dispatch-discipline] block -->",
      "",
    ].join("\n");
    writeFileSync(join(claudeDir, MD), stale);
    const r = await runHooksInstallClaudeMd({ claudeDir });
    expect(r.installed).toBe(true);
    const body = readFileSync(join(claudeDir, MD), "utf8");
    const headerCount = body.split("managed [dispatch-discipline] block — do not edit").length - 1;
    expect(headerCount).toBe(1);
    expect(body).not.toContain("stale body");
    expect(body).toContain("Dispatch discipline (penumbra)");
  });

  it("rewrites a stale block even when the current version string appears OUTSIDE it (FIX 4)", async () => {
    const claudeDir = tmpClaudeDir();
    // A stale block (v0 marker) AND the CURRENT version string written as user text
    // outside the block. The old whole-file scan would see `<!-- v1 -->` and skip the
    // needed rewrite; the in-block extraction must rewrite the stale block.
    const seeded = [
      "# My notes",
      "I once pasted the marker <!-- v1 --> here as a note.",
      "",
      "<!-- penumbra: managed [dispatch-discipline] block — do not edit between markers -->",
      "<!-- v0 -->",
      "stale body",
      "<!-- penumbra: end managed [dispatch-discipline] block -->",
      "",
    ].join("\n");
    writeFileSync(join(claudeDir, MD), seeded);
    const r = await runHooksInstallClaudeMd({ claudeDir });
    expect(r.installed).toBe(true);
    expect(r.idempotent).not.toBe(true);
    const body = readFileSync(join(claudeDir, MD), "utf8");
    expect(body).not.toContain("stale body");
    expect(body).toContain("Dispatch discipline (penumbra)");
    // Exactly one managed block after the rewrite.
    const headerCount = body.split("managed [dispatch-discipline] block — do not edit").length - 1;
    expect(headerCount).toBe(1);
    // User's note text outside the block is preserved.
    expect(body).toContain("I once pasted the marker");
  });

  it("uninstall removes the block, preserving surrounding text", async () => {
    const claudeDir = tmpClaudeDir();
    const userText = "# Keep me\n";
    writeFileSync(join(claudeDir, MD), userText);
    await runHooksInstallClaudeMd({ claudeDir });
    const r = await runHooksUninstallClaudeMd({ claudeDir });
    expect(r.removed).toBe(true);
    const body = readFileSync(join(claudeDir, MD), "utf8");
    expect(body).toContain("# Keep me");
    expect(body).not.toContain("managed [dispatch-discipline] block");
  });

  it("uninstall is a no-op when no block exists", async () => {
    const claudeDir = tmpClaudeDir();
    writeFileSync(join(claudeDir, MD), "# unrelated\n");
    const r = await runHooksUninstallClaudeMd({ claudeDir });
    expect(r.removed).toBe(false);
  });
});
