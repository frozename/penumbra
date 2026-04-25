#!/usr/bin/env bun
import { Branding } from '@penumbra/core';
import { runInit } from '../src/commands/init.js';
import { runStart } from '../src/commands/start.js';
import { runStop } from '../src/commands/stop.js';
import { runStatus } from '../src/commands/status.js';

const cmd = process.argv[2];
const root = process.env.PENUMBRA_STORAGE_ROOT ?? Branding.storageRoot;

switch (cmd) {
  case 'init':
    process.exit(await runInit({ storageRoot: root }));
  case 'start': {
    const handle = await runStart({ storageRoot: root });
    let stopping = false;
    const onSignal = async () => {
      if (stopping) return;
      stopping = true;
      await runStop({ storageRoot: root, handle });
      process.exit(0);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    console.log(`penumbra: running on http://127.0.0.1:${handle.port} (pid=${process.pid}). Ctrl-C to stop.`);
    await new Promise<never>(() => {}); // block forever; signals drive exit
    process.exit(0);
  }
  case 'stop':
    process.exit(await runStop({ storageRoot: root }));
  case 'status': {
    const s = await runStatus({ storageRoot: root });
    console.log(JSON.stringify(s, null, 2));
    process.exit(s.status === 'running' ? 0 : 2);
  }
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log('usage: penumbra <init|start|stop|status|export|import|repair>');
    process.exit(0);
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}
