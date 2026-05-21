import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export interface WorkerTokenStoreLike {
  lookup(plaintextToken: string): { token_hash: string; worker_id: string } | null;
}

export type Principal =
  | { kind: 'shared'; via: 'config' }
  | { kind: 'worker'; worker_id: string; token_hash: string };

export interface AuthOpts {
  token: string;
  workerTokenStore?: WorkerTokenStoreLike;
}

const principals = new WeakMap<Request, Principal>();

export function getPrincipal(req: Request): Principal | null {
  return principals.get(req) ?? null;
}

export function createBearerAuth(opts: AuthOpts): (req: Request) => Response | null {
  const expected = Buffer.from(`Bearer ${opts.token}`);
  return (req) => {
    const header = req.headers.get('authorization');
    if (header === null) return unauthorized();

    // Try shared bearer first (constant-time compare)
    const received = Buffer.from(header);
    if (received.length === expected.length && timingSafeEqual(received, expected)) {
      principals.set(req, { kind: 'shared', via: 'config' });
      return null;
    }

    // Try worker bearer if a store is configured
    if (opts.workerTokenStore && header.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length);
      const row = opts.workerTokenStore.lookup(token);
      if (row) {
        principals.set(req, { kind: 'worker', worker_id: row.worker_id, token_hash: row.token_hash });
        return null;
      }
    }

    return unauthorized();
  };
}

export function requireWorkerPrincipalMatch(
  req: Request,
  body_worker_id: string,
): Response | null {
  const principal = getPrincipal(req);
  if (principal === null || principal.kind !== 'worker') {
    return Response.json(
      { error: { code: 'worker_token_required', message: 'this route requires a per-worker bearer token' } },
      { status: 403 },
    );
  }
  if (principal.worker_id !== body_worker_id) {
    return Response.json(
      { error: { code: 'worker_id_mismatch', message: 'body worker_id does not match credential' } },
      { status: 403 },
    );
  }
  return null;
}

function unauthorized(): Response {
  return Response.json(
    { error: { code: 'unauthorized', message: 'missing or invalid bearer token' } },
    { status: 401 },
  );
}
