#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildServer } from '../src/server.js';
import { DaemonClient } from '../src/daemon-client.js';

const root = process.env.PENUMBRA_STORAGE_ROOT ?? join(homedir(), '.penumbra');
const tokenPath = join(root, 'token');
const portPath = join(root, 'port');

if (!existsSync(tokenPath) || !existsSync(portPath)) {
  console.error(`penumbra-mcp: missing ${tokenPath} or ${portPath}. Run 'penumbra init' + 'penumbra start' first.`);
  process.exit(1);
}

const token = readFileSync(tokenPath, 'utf8').trim();
const port = readFileSync(portPath, 'utf8').trim();

if (!token) {
  console.error(`penumbra-mcp: token file ${tokenPath} is empty.`);
  process.exit(1);
}
const portNum = Number(port);
if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
  console.error(`penumbra-mcp: port file ${portPath} does not contain a valid port (got: '${port}').`);
  process.exit(1);
}

const daemon = new DaemonClient({ baseUrl: `http://127.0.0.1:${portNum}`, token });

const server = buildServer({ daemon });
const transport = new StdioServerTransport();
await server.connect(transport);
