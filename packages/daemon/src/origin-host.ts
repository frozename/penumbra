export interface OriginHostOpts {
  /**
   * When true, skips Origin and Host validation entirely. Intended for
   * dev/test (e.g. `PENUMBRA_ALLOW_REMOTE=1`). The daemon's default 127.0.0.1
   * bind still applies.
   */
  allowRemote?: boolean;
}

const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;
const LOOPBACK_BIND_RE = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|\[::1\])$/;

/**
 * Whether a bind address only accepts connections from this machine. The Host
 * header cannot substitute for this check: a remote client can send any Host
 * value it likes, so a non-loopback bind is genuinely network-reachable.
 */
export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_BIND_RE.test(host.trim());
}

/**
 * Returns a guard that mirrors createBearerAuth's shape: it returns a 403
 * Response when the request is rejected, or null to let the request continue.
 *
 * Origin: must be missing/null OR loopback (http://127.0.0.1[:port],
 * http://localhost[:port], or the literal string "null"). Browsers omit
 * the header on same-origin GETs and send "null" for sandboxed pages /
 * file:// pages — both are treated as non-cross-origin.
 *
 * Host: required, must be loopback. Defends against DNS rebinding —
 * even if a malicious page resolves a domain to 127.0.0.1, the Host
 * header it sends will be the original domain.
 */
export function createOriginHostGuard(
  opts: OriginHostOpts = {},
): (req: Request, origin?: string | null) => Response | null {
  const allowRemote = opts.allowRemote === true;
  return (req, origin = req.headers.get("origin")) => {
    if (allowRemote) return null;

    if (origin !== null && origin !== "null" && !LOOPBACK_ORIGIN_RE.test(origin)) {
      return forbidden(`origin not allowed: ${origin}`);
    }

    const host = req.headers.get("host");
    if (host === null) {
      return forbidden("missing host header");
    }
    if (!LOOPBACK_HOST_RE.test(host)) {
      return forbidden(`host not allowed: ${host}`);
    }
    return null;
  };
}

function forbidden(message: string): Response {
  return Response.json({ error: { code: "forbidden_origin", message } }, { status: 403 });
}
