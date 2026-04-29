import type { Services } from '@penumbra/core';
import { parseOtlpLogs, parseOtlpLogsProtobuf, normalizeOtlpLogsToUsageEvents, normalize } from '@penumbra/core';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function isJson(req: Request): boolean {
  const ct = req.headers.get('content-type') ?? '';
  return ct.includes('application/json');
}

function isProtobuf(req: Request): boolean {
  const ct = req.headers.get('content-type') ?? '';
  return ct.includes('application/x-protobuf') || ct.includes('application/protobuf');
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
  let records;
  if (isJson(req)) {
    let envelope: unknown;
    try { envelope = await req.json(); }
    catch (e) { return json({ error: { code: 'invalid_json', message: (e as Error).message } }, 400); }
    records = parseOtlpLogs(envelope);
  } else if (isProtobuf(req)) {
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await req.arrayBuffer()); }
    catch (e) { return json({ error: { code: 'invalid_body', message: (e as Error).message } }, 400); }
    try { records = parseOtlpLogsProtobuf(bytes); }
    catch (e) {
      // Return 200 on parse failure — OTLP exporters (codex, claude-code) treat 4xx
      // as a hard error and retry, which loops if a particular body has a quirk our
      // parser can't handle. The bad body is dropped; downstream OTLP traffic continues.
      return json({ accepted: 0, parse_error: (e as Error).message });
    }
  } else {
    return json({ error: { code: 'unsupported_media_type', message: 'OTLP/HTTP route requires application/json or application/x-protobuf' } }, 415);
  }

  const inputs = normalizeOtlpLogsToUsageEvents(records);
  const ctx = makeNormalizeCtx(services);
  for (const input of inputs) {
    const event = normalize(input, ctx);
    services.t0Writer.write(event);
  }
  return json({ accepted: inputs.length });
}

export async function otlpMetricsRoute(req: Request, _services: Services): Promise<Response> {
  if (!isJson(req) && !isProtobuf(req)) return json({ error: { code: 'unsupported_media_type' } }, 415);
  // Accept-and-discard: gemini-cli double-reports tokens via metrics+logs. We use the
  // logs path as canonical (Task 3) to avoid double-counting. Drain the body so the
  // exporter sees a clean 200.
  try { await req.arrayBuffer(); } catch { /* ignore */ }
  return json({ accepted: 0 });
}

export async function otlpTracesRoute(req: Request, _services: Services): Promise<Response> {
  if (!isJson(req) && !isProtobuf(req)) return json({ error: { code: 'unsupported_media_type' } }, 415);
  try { await req.arrayBuffer(); } catch { /* ignore */ }
  return json({ accepted: 0 });
}
