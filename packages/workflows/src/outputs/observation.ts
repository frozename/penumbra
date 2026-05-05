import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ObservationOutputResult = { warnings: string[]; eventId?: string };

export type ObservationOutputInput = {
  body: string;
  storageRoot: string;
  workflowName: string;
  project?: string | null;
  sessionId?: string | null;
  ts?: string;
};

function readDaemon(storageRoot: string): { baseUrl: string; token: string } | null {
  const portPath = join(storageRoot, 'port');
  const tokenPath = join(storageRoot, 'token');
  if (!existsSync(portPath) || !existsSync(tokenPath)) return null;
  const port = readFileSync(portPath, 'utf8').trim();
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!port || Number.isNaN(Number(port)) || !token) return null;
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

export async function emitObservationOutput(
  input: ObservationOutputInput,
): Promise<ObservationOutputResult> {
  const daemon = readDaemon(input.storageRoot);
  if (!daemon) {
    return { warnings: [`output observation: daemon port/token not found in ${input.storageRoot}`] };
  }
  const ts = input.ts ?? new Date().toISOString();
  const projectId =
    input.project && input.project !== 'unknown' && input.project.length > 0 ? input.project : null;
  const summary = input.body.length > 240 ? input.body.slice(0, 240) : input.body;
  const payload = {
    ts,
    source: 'agentchat' as const,
    source_detail: `workflow:${input.workflowName}`,
    project_id: projectId,
    session_id: input.sessionId ?? null,
    event_type: 'agent-response' as const,
    lane: 'unknown' as const,
    payload_summary: summary,
    payload_json: {
      workflow_name: input.workflowName,
      full_summary: input.body,
      session_id: input.sessionId ?? null,
      project_id: projectId,
    },
    user_id: 'penumbra-workflow',
    machine_id: process.env.HOSTNAME ?? 'local',
  };
  try {
    const res = await fetch(`${daemon.baseUrl}/observations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${daemon.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { warnings: [`output observation: daemon responded ${res.status}`] };
    }
    const data = (await res.json().catch(() => null)) as { event_id?: string } | null;
    return { warnings: [], eventId: data?.event_id };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { warnings: [`output observation: ${msg}`] };
  }
}
