import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildServer } from '../src/server.js';
import type { DaemonClient } from '../src/daemon-client.js';

export async function connectInMemory(daemon: DaemonClient): Promise<Client> {
  const server = await buildServer({ daemon });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}
