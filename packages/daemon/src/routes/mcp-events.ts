import { z } from 'zod';
import { getMcpEventBus } from '../events/mcp-event-bus.js';

const PublishBody = z.object({
  server: z.string().min(1),
  event: z.string().min(1),
  payload: z.unknown(),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function mcpEventsPublishRoute(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const parsed = PublishBody.safeParse(raw);
  if (!parsed.success) return json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const bus = getMcpEventBus();
  bus.publish({ ...parsed.data, published_at: Date.now() });
  return json({ ok: true }, 202);
}
