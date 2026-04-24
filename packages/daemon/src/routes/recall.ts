import type { Services } from '@penumbra/core';
import { RecallRequestSchema } from '@penumbra/core';

export async function recallRoute(req: Request, services: Services): Promise<Response> {
  let raw: unknown;
  try { raw = await req.json(); } catch { return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400); }
  const parsed = RecallRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }
  const results = await services.recallReader.recall(parsed.data);
  services.db.run(
    'INSERT INTO recall_audit(recall_id, ts, project_id, user_id, query_text, result_ids) VALUES(?,?,?,?,?,?)',
    [services.uuid(), services.clock().toISOString(), parsed.data.project_id,
     services.machineId.get(), parsed.data.query,
     JSON.stringify(results.map((r) => r.id))],
  );
  return json({ results });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
