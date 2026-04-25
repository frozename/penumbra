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

    const turn = await runChatTurn({
      config, initialAgent: planner, userMessage, conversation: conv,
    });
    console.log(`\n[${planner}]\n${turn.text}\n`);

    if (turn.next_mention) {
      const handoff = await penumbra.createHandoff({
        from: planner,
        to: turn.next_mention.resolution.kind === 'unknown' ? turn.next_mention.target : (turn.next_mention.resolution as any).agent_name,
        to_role: turn.next_mention.resolution.kind === 'role' ? (turn.next_mention.resolution as any).role : null,
        message: turn.text,
        conversation_id: conv.id,
        project_id: conv.project_id,
        triggered_by_event_id: 'inline-1', // simplified for v1; real bin chains real event ids
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

console.error(`unknown command: ${cmd}`);
process.exit(1);

async function readOneLine(): Promise<string> {
  for await (const l of console as any) return (l as string).trim();
  return '';
}
