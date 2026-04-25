#!/usr/bin/env bun
import { Branding } from '@penumbra/core';
import { runInit } from '../src/commands/init.js';

const cmd = process.argv[2];
const root = process.env.PENUMBRA_STORAGE_ROOT ?? Branding.storageRoot;

switch (cmd) {
  case 'init':
    process.exit(await runInit({ storageRoot: root }));
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(`usage: penumbra <init|start|stop|status|export|import|repair>`);
    process.exit(0);
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}
