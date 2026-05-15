import { createSiriusChat, refineDispatchPrompt, type Services } from '@penumbra/core';
import { json } from './_helpers.js';

export async function dispatchRefineRoute(req: Request, _services: Services): Promise<Response> {
  let body: { message?: unknown };
  try {
    body = await req.json() as { message?: unknown };
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (typeof body.message !== 'string' || body.message.length === 0) {
    return json({ error: 'missing_message' }, 400);
  }

  const url = process.env.PENUMBRA_SIRIUS_BASE_URL || process.env.SIRIUS_URL;
  const model = process.env.PENUMBRA_REFINER_MODEL || process.env.PENUMBRA_SIRIUS_MODEL || 'gpt-4o';
  if (!url) {
    return json({ error: 'refiner_unavailable', reason: 'no PENUMBRA_SIRIUS_BASE_URL/SIRIUS_URL configured' }, 503);
  }
  const chat = createSiriusChat({
    baseUrl: url,
    token: process.env.PENUMBRA_SIRIUS_TOKEN || '',
  });

  try {
    const refined = await refineDispatchPrompt({ message: body.message, chat, model });
    return json({ refined });
  } catch (err) {
    return json({ error: 'refine_failed', message: err instanceof Error ? err.message : String(err) }, 502);
  }
}
