#!/usr/bin/env bun
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/load.js';
import { PenumbraClient } from '../src/penumbra-client.js';
import { runChatTurn } from '../src/cli/loop.js';
import { parseApprovalKey } from '../src/cli/inline-approval.js';

const cmd = process.argv[2];
const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
const storageRoot = process.env.PENUMBRA_STORAGE_ROOT ?? join(homedir(), '.penumbra');

if (cmd === 'help' || cmd === '--help' || cmd === undefined) {
  console.log('usage: agentchat <new|resume|queue|approve|reject> [args]');
  process.exit(0);
}

if (cmd === 'new') {
  const project = process.argv[3] ?? null;
  const config = loadConfig(configPath);
  const conv = { id: `conv-${Date.now()}`, project_id: project };
  const penumbra = new PenumbraClient({ storageRoot });

  process.stdout.write(`> `);
  for await (const line of console as any) {
    const userMessage = (line as string).trim();
    if (!userMessage) { process.stdout.write(`> `); continue; }
    if (userMessage === 'done') break;

    const planner = config.default_roles.planner;
    if (!planner) { console.error('no default planner configured'); process.exit(1); }

    const promptEvent = await penumbra.observe({
      ts: new Date().toISOString(),
      source: 'cli',
      event_type: 'agent-prompt',
      session_id: conv.id,
      project_id: conv.project_id,
      user_id: 'local-user',
      machine_id: 'local',
      payload_json: { prompt: userMessage },
      payload_summary: userMessage.slice(0, 240),
    });

    const turn = await runChatTurn({
      config, initialAgent: planner, userMessage, conversation: conv,
    });
    console.log(`\n[${planner}]\n${turn.text}\n`);

    const responseEvent = await penumbra.observe({
      ts: new Date().toISOString(),
      source: 'cli',
      event_type: 'agent-response',
      session_id: conv.id,
      project_id: conv.project_id,
      user_id: planner,
      machine_id: 'local',
      payload_json: { response: turn.text },
      payload_summary: turn.text.slice(0, 240),
      triggered_by_event_id: promptEvent.event_id,
    });

    if (turn.next_mention) {
      const handoff = await penumbra.createHandoff({
        from: planner,
        to: turn.next_mention.resolution.kind === 'unknown' ? turn.next_mention.target : (turn.next_mention.resolution as any).agent_name,
        to_role: turn.next_mention.resolution.kind === 'role' ? (turn.next_mention.resolution as any).role : null,
        message: turn.text,
        conversation_id: conv.id,
        project_id: conv.project_id,
        triggered_by_event_id: responseEvent.event_id,
      });
      process.stdout.write(`[handoff ${handoff.handoff_id.slice(0, 8)}…] @${turn.next_mention.target}\napprove? [y/n/r <name>/s] › `);
      const reply = await readOneLine();
      const choice = parseApprovalKey(reply);
      if (choice?.kind === 'yes') {
        await penumbra.approve(handoff.handoff_id);
        console.log(`approved.`);
      } else if (choice?.kind === 'redirect') {
        await penumbra.approve(handoff.handoff_id, { redirect_to: choice.target });
        console.log(`redirected → ${choice.target}.`);
      } else if (choice?.kind === 'no') {
        await penumbra.approve(handoff.handoff_id, { reject: true });
        console.log(`rejected.`);
      }
    }
    process.stdout.write(`> `);
  }
  process.exit(0);
}

if (cmd === 'queue') {
  if (process.argv[3] === '--help') {
    console.log('usage: agentchat queue');
    process.exit(0);
  }
  const { runQueue } = await import('../src/cli/queue.js');
  const rows = await runQueue({ storageRoot });
  console.log(`HANDOFF_ID\tTS\t\t\tFROM\t\tTO\t\tSTATUS\t\tMESSAGE`);
  for (const r of rows) {
    console.log(`${r.handoff_id.slice(0, 8)}\t${r.ts}\t${r.from_agent.padEnd(8)}\t${r.to_agent.padEnd(8)}\t${r.status.padEnd(8)}\t${r.message.slice(0, 60)}`);
  }
  process.exit(0);
}

if (cmd === 'approve' || cmd === 'reject') {
  const id = process.argv[3];
  if (!id) { console.error(`usage: agentchat ${cmd} <handoff_id> [--redirect <name>] [--reason <text>]`); process.exit(1); }
  const redirectIdx = process.argv.indexOf('--redirect');
  const redirectTo = redirectIdx >= 0 ? (process.argv[redirectIdx + 1] ?? undefined) : undefined;
  const reasonIdx = process.argv.indexOf('--reason');
  const reason = reasonIdx >= 0 ? (process.argv[reasonIdx + 1] ?? undefined) : undefined;
  const { runApprove } = await import('../src/cli/approve.js');
  const r = await runApprove({
    storageRoot, handoffId: id,
    redirectTo, reason,
    reject: cmd === 'reject',
  });
  console.log(`${r.handoff_id} ${r.status}.`);
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
process.exit(1);

async function readOneLine(): Promise<string> {
  for await (const l of console as any) return (l as string).trim();
  return '';
}
as any) return (l as string).trim();
  return '';
}
