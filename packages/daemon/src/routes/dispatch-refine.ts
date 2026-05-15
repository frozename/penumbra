import { refineDispatchPrompt, RefineError, type SiriusChatFn } from '@penumbra/core';
import { json } from './_helpers.js';

export interface DispatchRefineConfig {
  chat: SiriusChatFn | null;
  model: string;
}

const REQUEST_BODY_MAX_BYTES = 128 * 1024;

const ERROR_MAP: Record<string, { status: number; code: string }> = {
  input_too_large: { status: 413, code: 'input_too_large' },
  input_blank: { status: 400, code: 'input_blank' },
  output_empty: { status: 502, code: 'refiner_returned_empty' },
  output_too_large: { status: 502, code: 'refiner_returned_oversize' },
  upstream_failed: { status: 502, code: 'refiner_upstream_failed' },
};

export function makeDispatchRefineRoute(config: DispatchRefineConfig) {
  return async (req: Request): Promise<Response> => {
    if (!config.chat) {
      return json({ error: 'refiner_unavailable', reason: 'PENUMBRA_SIRIUS_BASE_URL not configured on the daemon' }, 503);
    }
    const contentLength = req.headers.get('content-length');
    if (contentLength && Number(contentLength) > REQUEST_BODY_MAX_BYTES) {
      return json({ error: 'payload_too_large' }, 413);
    }
    let body: { message?: unknown };
    try {
      body = await req.json() as { message?: unknown };
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (typeof body.message !== 'string') {
      return json({ error: 'missing_message' }, 400);
    }
    try {
      const refined = await refineDispatchPrompt({ message: body.message, chat: config.chat, model: config.model });
      return json({ refined });
    } catch (err) {
      if (err instanceof RefineError) {
        const mapping = ERROR_MAP[err.code] ?? { status: 500, code: 'refiner_error' };
        return json({ error: mapping.code }, mapping.status);
      }
      return json({ error: 'refiner_error' }, 500);
    }
  };
}
