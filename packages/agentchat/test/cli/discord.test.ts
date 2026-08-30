import { runDiscordCli } from "@src/cli/discord.js";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeConfigFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-discord-cli-"));
  writeFileSync(join(dir, "agentchat.yaml"), yaml);
  tempDirs.push(dir);
  return join(dir, "agentchat.yaml");
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = "";

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };

  try {
    return { code: await fn(), output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

describe("runDiscordCli", () => {
  it("validate reports configured routes without printing webhook tokens", async () => {
    const configPath = writeConfigFile(`
agents:
  - name: codex
    adapter: codex-cli
notifications:
  channels:
    discord:
      kind: discord_webhook
      default_webhook_url_env: PENUMBRA_DISCORD_WEBHOOK_URL
  routes:
    projects:
      penumbra:
        channel: discord
        webhook_url_env: PENUMBRA_DISCORD_PROJECT_WEBHOOK_URL
`);

    const { code, output } = await captureStdout(() =>
      runDiscordCli(["validate"], {
        env: {
          AGENTCHAT_CONFIG: configPath,
          PENUMBRA_DISCORD_WEBHOOK_URL: "https://discord.test/api/webhooks/default/token",
          PENUMBRA_DISCORD_PROJECT_WEBHOOK_URL: "https://discord.test/api/webhooks/project/token",
        },
        fetch: mock(() => Promise.resolve(new Response(null, { status: 204 }))),
      }),
    );

    expect(code).toBe(0);
    expect(output).toContain("default: configured");
    expect(output).toContain("project penumbra: configured");
    expect(output).not.toContain("webhooks/default/token");
    expect(output).not.toContain("webhooks/project/token");
  });

  it("validate returns 1 when a referenced env var is unset", async () => {
    const configPath = writeConfigFile(`
agents:
  - name: codex
    adapter: codex-cli
notifications:
  channels:
    discord:
      kind: discord_webhook
      default_webhook_url_env: PENUMBRA_DISCORD_WEBHOOK_URL
  routes:
    projects:
      penumbra:
        channel: discord
        webhook_url_env: PENUMBRA_DISCORD_PROJECT_WEBHOOK_URL
`);

    const { code, output } = await captureStdout(() =>
      runDiscordCli(["validate"], {
        env: {
          AGENTCHAT_CONFIG: configPath,
          PENUMBRA_DISCORD_WEBHOOK_URL: "https://discord.test/api/webhooks/default/token",
        },
        fetch: mock(() => Promise.resolve(new Response(null, { status: 204 }))),
      }),
    );

    expect(code).toBe(1);
    expect(output).toContain("project penumbra: configured");
    expect(output).toContain("env PENUMBRA_DISCORD_PROJECT_WEBHOOK_URL: unset");
    expect(output).not.toContain("webhooks/default/token");
  });

  it("render prints JSON with the route key and embed payload", async () => {
    const configPath = writeConfigFile(`
agents:
  - name: codex
    adapter: codex-cli
notifications:
  channels:
    discord:
      kind: discord_webhook
      default_webhook_url_env: PENUMBRA_DISCORD_WEBHOOK_URL
`);

    const { code, output } = await captureStdout(() =>
      runDiscordCli(
        ["render", "--event", "dispatch_end", "--project-id", "penumbra", "--agent", "codex"],
        {
          env: {
            AGENTCHAT_CONFIG: configPath,
            PENUMBRA_DISCORD_WEBHOOK_URL: "https://discord.test/api/webhooks/default/token",
          },
          fetch: mock(() => Promise.resolve(new Response(null, { status: 204 }))),
        },
      ),
    );

    const rendered = output.trim();
    expect(code).toBe(0);
    const parsed = JSON.parse(rendered) as {
      route_key: string;
      payload: { embeds: { title: string }[] };
    };
    expect(parsed.route_key).toBe("default");
    expect(parsed.payload.embeds[0]!.title).toContain("dispatch");
  });

  it("test posts once to the resolved webhook using injected fetch", async () => {
    const configPath = writeConfigFile(`
agents:
  - name: codex
    adapter: codex-cli
notifications:
  channels:
    discord:
      kind: discord_webhook
      default_webhook_url_env: PENUMBRA_DISCORD_WEBHOOK_URL
`);

    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 204 })));
    const { code } = await captureStdout(() =>
      runDiscordCli(["test", "--project-id", "penumbra", "--agent", "codex"], {
        env: {
          AGENTCHAT_CONFIG: configPath,
          PENUMBRA_DISCORD_WEBHOOK_URL: "https://discord.test/api/webhooks/default/token",
        },
        fetch: fetchMock,
      }),
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
