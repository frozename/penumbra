import type { Services } from '@penumbra/core';
import { RecallRequestSchema, stripPrivacyTags } from '@penumbra/core';
import { json } from './_helpers.js';
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
  // <private>...</private> blocks are stripped from the query before it reaches
  // the embedder or the audit log — user-annotated content never leaves the route raw.
  const query = stripPrivacyTags(parsed.data.query);
  const results = await services.recallReader.recall({ ...parsed.data, query });
  services.db.run(
    'INSERT INTO recall_audit(recall_id, ts, project_id, user_id, query_text, result_ids) VALUES(?,?,?,?,?,?)',
    [services.uuid(), services.clock().toISOString(), parsed.data.project_id,
     services.machineId.get(), query,
     JSON.stringify(results.map((r) => r.id))],
  );
  return json({ results });
}

