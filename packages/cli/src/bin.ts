#!/usr/bin/env bun
import { resolveCliStorageRoot } from './storage-root.js';

if (process.argv[2] === 'env') {
  const evalFlag = process.argv.includes('--eval');
  const storageRoot = resolveCliStorageRoot();
  const lines = [
    `export PENUMBRA_STORAGE_ROOT=${JSON.stringify(storageRoot)};`,
    `export DEV_STORAGE=${JSON.stringify(process.env.DEV_STORAGE ?? storageRoot)};`,
  ];
  if (evalFlag) {
    console.log(lines.join(' '));
  } else {
    console.log(lines.map((line) => line.replace(/^export /, '')).join('\n'));
  }
} else {
  await import('../bin/penumbra.ts');
}
