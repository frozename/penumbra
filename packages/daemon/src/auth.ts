export interface AuthOpts { token: string }

export function createBearerAuth(opts: AuthOpts): (req: Request) => Response | null {
  const expected = `Bearer ${opts.token}`;
  return (req) => {
    const header = req.headers.get('authorization');
    if (header !== expected) {
      return new Response(JSON.stringify({ code: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return null;
  };
}
