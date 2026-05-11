#!/usr/bin/env bun
import { stdin, stdout } from 'node:process';

const delay = parseInt(process.env.ECHO_DELAY_MS ?? '0', 10);
let buf = '';

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    setTimeout(() => respond(req), delay);
  }
});

function respond(req: any) {
  let result;
  if (req.method === 'initialize') {
    result = { protocolVersion: '2025-03-26', capabilities: {} };
  } else if (req.method === 'tools/list') {
    result = { tools: [{ name: 'echo', description: 'echoes its args' }] };
  } else if (req.method === 'tools/call') {
    if (req.params?.name === 'unknown') {
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method_not_found' } }) + '\n');
      return;
    }
    result = { content: [{ type: 'text', text: JSON.stringify(req.params.arguments ?? null) }] };
  } else {
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method_not_found' } }) + '\n');
    return;
  }
  stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
}
