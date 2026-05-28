import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { runDiscordCli } from "../../src/cli/discord.js";

function writeConfigFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-discord-cli-"));
  writeFileSync(join(dir, "agentchat.yaml"), yaml);
  tempDirs.push(dir);
  return join(dir, "agentchat.yaml");
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = "";

  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

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
        fetch: mock(async () => new Response(null, { status: 204 })) as typeof fetch,
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
        fetch: mock(async () => new Response(null, { status: 204 })) as typeof fetch,
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
          fetch: mock(async () => new Response(null, { status: 204 })) as typeof fetch,
        },
      ),
    );

    const rendered = output.trim();
    expect(code).toBe(0);
    expect(JSON.parse(rendered).route_key).toBe("default");
    expect(JSON.parse(rendered).payload.embeds[0].title).toContain("dispatch");
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

    const fetchMock = mock(async () => new Response(null, { status: 204 }));
    const { code } = await captureStdout(() =>
      runDiscordCli(["test", "--project-id", "penumbra", "--agent", "codex"], {
        env: {
          AGENTCHAT_CONFIG: configPath,
          PENUMBRA_DISCORD_WEBHOOK_URL: "https://discord.test/api/webhooks/default/token",
        },
        fetch: fetchMock as typeof fetch,
      }),
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
