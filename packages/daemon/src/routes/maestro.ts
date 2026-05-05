import { MaestroSessionWriter } from '@penumbra/core';
import type { Services } from '@penumbra/core';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function maestroSessionGetRoute(req: Request, task_id: string, services: Services): Promise<Response> {
  const servicesWithMaestro = services as Services & { maestroSessions?: MaestroSessionWriter };
  const maestroSessions = servicesWithMaestro.maestroSessions ?? new MaestroSessionWriter({
    db: services.db,
  });
  const session = maestroSessions.get(task_id);
  if (!session) {
    return json({ error: { code: 'not_found', message: `maestro session ${task_id} not found` } }, 404);
  }
  return json(session);
}
