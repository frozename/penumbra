import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DispatchTimelineEvent {
  handoff_id: string;
  worker_id: string | null;
  source: string;
  kind: string;
  ts: string;
  meta: Record<string, unknown> | null;
}

export interface DispatchTimelineResponse {
  events: DispatchTimelineEvent[];
}

export interface RunDispatchTimelineOpts {
  handoffId: string;
  json: boolean;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

function defaultPrint(line: string): void {
  process.stdout.write(`${line}\n`);
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const portPath = join(storageRoot, 'port');
  const tokenPath = join(storageRoot, 'token');
  if (!existsSync(portPath) || !existsSync(tokenPath)) {
    throw new Error(`penumbra dispatch timeline: missing ${portPath} or ${tokenPath}. Run 'penumbra start' first.`);
  }

  const port = Number(readFileSync(portPath, 'utf8').trim());
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`penumbra dispatch timeline: invalid daemon port in ${portPath}`);
  }
  if (!token) {
    throw new Error(`penumbra dispatch timeline: empty daemon token in ${tokenPath}`);
  }

  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

export async function runDispatchTimeline(opts: RunDispatchTimelineOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const daemon = resolveDaemon(opts.storageRoot);
  const params = new URLSearchParams({ handoff_id: opts.handoffId });
  const res = await fetcher(`${daemon.baseUrl}/dispatch/events?${params.toString()}`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (!res.ok) {
    throw new Error(`penumbra dispatch timeline: daemon /dispatch/events returned HTTP ${res.status}`);
  }

  const body = await res.json() as DispatchTimelineResponse;
  if (opts.json) {
    print(JSON.stringify(body, null, 2));
    return;
  }

  if (body.events.length === 0) {
    print('(no events)');
    return;
  }

  for (const event of body.events) {
    const meta = event.meta == null ? '-' : JSON.stringify(event.meta);
    print(`${event.ts}  ${event.source}  ${event.kind}  ${meta}`);
  }
}
