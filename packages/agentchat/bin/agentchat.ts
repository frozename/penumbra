#!/usr/bin/env bun
import { resolveDaemonStorageRoot } from "@penumbra/core";

const stdoutWriteln = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const argAt = (idx: number): string | undefined => process.argv[idx];

const cmd = argAt(2);

if (cmd === "help" || cmd === "--help" || cmd === undefined) {
  stdoutWriteln("usage: agentchat <queue|discord|approve|reject> [args]");
  process.exit(0);
}

let storageRoot: string;
try {
  storageRoot = resolveDaemonStorageRoot();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (cmd === "queue") {
  if (argAt(3) === "--help") {
    stdoutWriteln("usage: agentchat queue");
    process.exit(0);
  }
  const { runQueue } = await import("../src/cli/queue.js");
  const rows = await runQueue({ storageRoot });
  stdoutWriteln(`HANDOFF_ID\tTS\t\t\tFROM\t\tTO\t\tSTATUS\t\tMESSAGE`);
  for (const r of rows) {
    stdoutWriteln(
      `${r.handoff_id.slice(0, 8)}\t${r.ts}\t${r.from_agent.padEnd(8)}\t${r.to_agent.padEnd(8)}\t${r.status.padEnd(8)}\t${r.message.slice(0, 60)}`,
    );
  }
  process.exit(0);
}

if (cmd === "discord") {
  const { runDiscordCli } = await import("../src/cli/discord.js");
  process.exit(await runDiscordCli(process.argv.slice(3), { env: process.env, fetch }));
}

if (cmd === "approve" || cmd === "reject") {
  const id = argAt(3);
  if (!id) {
    console.error(`usage: agentchat ${cmd} <handoff_id> [--redirect <name>] [--reason <text>]`);
    process.exit(1);
  }
  const redirectIdx = process.argv.indexOf("--redirect");
  const redirectTo = redirectIdx >= 0 ? (argAt(redirectIdx + 1) ?? undefined) : undefined;
  const reasonIdx = process.argv.indexOf("--reason");
  const reason = reasonIdx >= 0 ? (argAt(reasonIdx + 1) ?? undefined) : undefined;
  const { runApprove } = await import("../src/cli/approve.js");
  const r = await runApprove({
    storageRoot,
    handoffId: id,
    redirectTo,
    reason,
    reject: cmd === "reject",
  });
  stdoutWriteln(`${r.handoff_id} ${r.status}.`);
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
process.exit(1);
