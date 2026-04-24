import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export interface AuthOpts { token: string }

export function createBearerAuth(opts: AuthOpts): (req: Request) => Response | null {
  const expected = Buffer.from(`Bearer ${opts.token}`);
  return (req) => {
    const header = req.headers.get('authorization');
    if (header === null) return unauthorized();
    const received = Buffer.from(header);
    if (received.length !== expected.length) return unauthorized();
    if (!timingSafeEqual(received, expected)) return unauthorized();
    return null;
  };
}

function unauthorized(): Response {
  return Response.json(
    { error: { code: 'unauthorized', message: 'missing or invalid bearer token' } },
    { status: 401 },
  );
}
