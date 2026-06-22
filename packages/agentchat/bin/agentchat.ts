#!/usr/bin/env bun
import { resolveDaemonStorageRoot } from "@penumbra/core";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { buildAttachmentPreamble, parseAttachFlags } from "../src/cli/attachments.js";
import { runAutoChain } from "../src/cli/auto-loop.js";
import { parseApprovalKey } from "../src/cli/inline-approval.js";
import { parseInputStream } from "../src/cli/input.js";
import { runChatTurn } from "../src/cli/loop.js";
import { resolveInitialAgent } from "../src/cli/route-input.js";
import { loadConfig } from "../src/config/load.js";
import { PenumbraClient } from "../src/penumbra-client.js";

interface ConversationStreamEvent {
  type: string;
  agent_name?: string;
  delta?: string;
  error?: string | null;
  next_handoff_id?: string | null;
  reason?: string;
}

interface NodeJsErrnoLike {
  code?: string;
}

const stdoutWriteln = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const argAt = (idx: number): string | undefined => process.argv[idx];

const cmd = argAt(2);
const configPath =
  process.env.AGENTCHAT_CONFIG ?? join(homedir(), ".config/agentchat/agentchat.yaml");

if (cmd === "help" || cmd === "--help" || cmd === undefined) {
  stdoutWriteln("usage: agentchat <new|resume|queue|discord|approve|reject> [args]");
  process.exit(0);
}

let storageRoot: string;
try {
  storageRoot = resolveDaemonStorageRoot();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (cmd === "new") {
  const project =
    process.argv.find(
      (a) => !a.startsWith("-") && a !== "new" && a !== argAt(1) && a !== argAt(0),
    ) ?? null;
  const isAuto = process.argv.includes("--auto");
  const isTrust = process.argv.includes("--trust");
  const thin = process.argv.includes("--thin");
  const useChain = isAuto || isTrust;
  const trustMode: "all" | "config" = isAuto ? "all" : "config";

  const maxHopsIdx = process.argv.indexOf("--max-hops");
  const maxHops = maxHopsIdx >= 0 ? parseInt(argAt(maxHopsIdx + 1) ?? "", 10) : 5;
  if (useChain && (!Number.isFinite(maxHops) || maxHops <= 0)) {
    console.error("--max-hops must be greater than 0");
    process.exit(1);
  }

  const budgetIdx = process.argv.indexOf("--transcript-budget");
  const transcriptBudget = budgetIdx >= 0 ? parseInt(argAt(budgetIdx + 1) ?? "", 10) : 8192;

  const initialAgentIdx = process.argv.indexOf("--initial-agent");
  const initialAgentOverride = initialAgentIdx >= 0 ? argAt(initialAgentIdx + 1) : undefined;

  const config = loadConfig(configPath);
  const conv = { id: `conv-${String(Date.now())}`, project_id: project };
  const penumbra = new PenumbraClient({ storageRoot });

  const projectContext = ((): string | undefined => {
    if (!project) {
      return undefined;
    }
    const path = join(storageRoot, "context", project, "latest.md");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  })();

  let attachmentPreamble = "";
  try {
    attachmentPreamble = buildAttachmentPreamble(parseAttachFlags(process.argv));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const stdinMode: "split" | "whole" = process.stdin.isTTY ? "split" : "whole";
  if (stdinMode === "split") {
    process.stdout.write(`> `);
  }
  const rl = createInterface({ input: process.stdin });
  const events = parseInputStream(rl[Symbol.asyncIterator](), { mode: stdinMode });

  let firstMessage = true;
  for await (const event of events) {
    if (event.kind === "done") {
      break;
    }
    // Attachments only fire on the first user message — subsequent turns reuse
    // the conversation transcript. The preamble matches the llama-server webui's
    // `--- File: <name> ---` header convention so any model trained on that
    // format reads the file contents naturally.
    const userMessage =
      firstMessage && attachmentPreamble ? attachmentPreamble + event.text : event.text;
    firstMessage = false;

    let initialAgent: string;
    try {
      initialAgent = resolveInitialAgent(
        userMessage,
        config,
        initialAgentOverride ? { explicit: initialAgentOverride } : {},
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (!initialAgent) {
      console.error("no default planner configured and no valid mention found");
      process.exit(1);
    }

    if (useChain && thin) {
      await penumbra.startChain({
        initial_agent: initialAgent,
        message: userMessage,
        conversation_id: conv.id,
        project_id: conv.project_id,
        max_hops: maxHops,
        trust_mode: trustMode,
      });

      let lastHandoffId: string | null = null;
      try {
        for await (const rawEvent of penumbra.subscribeConversation(conv.id)) {
          const streamEvent = rawEvent as ConversationStreamEvent;
          if (streamEvent.type === "hop-start") {
            process.stdout.write(`\\n[${streamEvent.agent_name ?? ""}]\\n`);
          } else if (streamEvent.type === "token") {
            process.stdout.write(streamEvent.delta ?? "");
          } else if (streamEvent.type === "hop-end") {
            process.stdout.write("\\n\\n");
            if (streamEvent.error) {
              console.error(`[error: ${streamEvent.error}]`);
            } else if (streamEvent.next_handoff_id) {
              lastHandoffId = streamEvent.next_handoff_id;
              stdoutWriteln(`[auto-approved → next step]`);
            }
          } else if (streamEvent.type === "chain-end") {
            if (streamEvent.reason === "max_hops" && lastHandoffId) {
              stdoutWriteln(
                `[max-hops ${String(maxHops)} reached, handoff ${lastHandoffId.slice(0, 8)}… queued — resume with 'agentchat approve ${lastHandoffId.slice(0, 8)}']`,
              );
            } else if (streamEvent.reason === "cancelled" && lastHandoffId) {
              stdoutWriteln(
                `[chain stopped at untrusted edge, handoff ${lastHandoffId.slice(0, 8)}… queued — resume with 'agentchat approve ${lastHandoffId.slice(0, 8)}']`,
              );
            } else if (streamEvent.reason === "error") {
              console.error(`[chain ended with error]`);
            }
            break;
          }
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
      }
    } else if (useChain) {
      const res = await runAutoChain({
        config,
        initialAgent,
        userMessage,
        conversation: conv,
        maxHops,
        transcriptBudget,
        observe: (e: Record<string, unknown>) => penumbra.observe(e),
        createHandoff: (body: Parameters<typeof penumbra.createHandoff>[0]) =>
          penumbra.createHandoff(body),
        approve: (id: string, body: Parameters<typeof penumbra.approve>[1]) =>
          penumbra.approve(id, body),
        markFailed: (id: string, reason: string) => penumbra.markFailed(id, reason),
        trustMode,
        projectContext,
        onChunk: (s: string) => process.stdout.write(s),
      });

      if (res.terminatedReason === "max_hops" && res.cappedHandoffId) {
        stdoutWriteln(
          `[max-hops ${String(maxHops)} reached, handoff ${res.cappedHandoffId.slice(0, 8)}… queued — resume with 'agentchat approve ${res.cappedHandoffId.slice(0, 8)}']`,
        );
      } else if (res.terminatedReason === "untrusted" && res.cappedHandoffId) {
        stdoutWriteln(
          `[chain stopped at untrusted edge, handoff ${res.cappedHandoffId.slice(0, 8)}… queued — resume with 'agentchat approve ${res.cappedHandoffId.slice(0, 8)}']`,
        );
      }
    } else {
      process.stdout.write(`\n[${initialAgent}]\n`);
      const turn = await runChatTurn({
        config,
        initialAgent,
        userMessage,
        conversation: conv,
        observe: (e: Record<string, unknown>) => penumbra.observe(e),
        onChunk: (s: string) => process.stdout.write(s),
      });
      process.stdout.write("\n\n");
      if (turn.error) {
        console.error(`[${initialAgent}] error: ${turn.error.message}\n`);
        process.stdout.write(`> `);
        continue;
      }

      if (turn.next_mention) {
        const { resolution, target } = turn.next_mention;
        const handoff = await penumbra.createHandoff({
          from: initialAgent,
          to: resolution.kind === "unknown" ? target : resolution.agent_name,
          to_role: resolution.kind === "role" ? resolution.role : null,
          message: turn.text,
          conversation_id: conv.id,
          project_id: conv.project_id,
          triggered_by_event_id: turn.response_event_id,
        });
        let reply = "";
        try {
          reply = await rl.question(
            `[handoff ${handoff.handoff_id.slice(0, 8)}…] @${target}\napprove? [y/n/r <name>/s] › `,
          );
        } catch (err) {
          if ((err as NodeJsErrnoLike).code === "ERR_USE_AFTER_CLOSE") {
            stdoutWriteln("\n[stdin closed, ending]");
            break;
          }
          throw err;
        }
        const choice = parseApprovalKey(reply);
        if (choice?.kind === "yes") {
          await penumbra.approve(handoff.handoff_id);
          stdoutWriteln(`approved.`);
        } else if (choice?.kind === "redirect") {
          await penumbra.approve(handoff.handoff_id, { redirect_to: choice.target });
          stdoutWriteln(`redirected → ${choice.target}.`);
        } else if (choice?.kind === "no") {
          await penumbra.approve(handoff.handoff_id, { reject: true });
          stdoutWriteln(`rejected.`);
        }
      }
    }
    process.stdout.write(`> `);
  }
  rl.close();
  process.exit(0);
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
