import type { Services } from '@penumbra/core';
import { parseOtlpLogs, normalizeOtlpLogsToUsageEvents, normalize } from '@penumbra/core';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function isJson(req: Request): boolean {
  const ct = req.headers.get('content-type') ?? '';
  return ct.includes('application/json');
}

function makeNormalizeCtx(services: Services) {
  return {
    userId: services.machineId.get(),
    machineId: services.machineId.get(),
    now: services.clock,
    uuid: services.uuid,
    redactor: services.redactor,
  };
}

export async function otlpLogsRoute(req: Request, services: Services): Promise<Response> {
  if (!isJson(req)) return json({ error: { code: 'unsupported_media_type', message: 'OTLP/HTTP route requires application/json (set OTLP_PROTOCOL=http on the exporter)' } }, 415);
  let envelope: unknown;
  try { envelope = await req.json(); }
  catch (e) { return json({ error: { code: 'invalid_json', message: (e as Error).message } }, 400); }

  const records = parseOtlpLogs(envelope);
  const inputs = normalizeOtlpLogsToUsageEvents(records);
  const ctx = makeNormalizeCtx(services);
  for (const input of inputs) {
    const event = normalize(input, ctx);
    services.t0Writer.write(event);
  }
  return json({ accepted: inputs.length });
}

export async function otlpMetricsRoute(req: Request, _services: Services): Promise<Response> {
  if (!isJson(req)) return json({ error: { code: 'unsupported_media_type' } }, 415);
  // Accept-and-discard: gemini-cli double-reports tokens via metrics+logs. We use the
  // logs path as canonical (Task 3) to avoid double-counting. Drain the body so the
  // exporter sees a clean 200.
  try { await req.text(); } catch { /* ignore */ }
  return json({ accepted: 0 });
}

export async function otlpTracesRoute(req: Request, _services: Services): Promise<Response> {
  if (!isJson(req)) return json({ error: { code: 'unsupported_media_type' } }, 415);
  try { await req.text(); } catch { /* ignore */ }
  return json({ accepted: 0 });
}
