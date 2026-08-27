// IPv6 [::1] is deliberately excluded so the browser allowlist stays fail-closed.
// The daemon has no cookie auth; this allowlist remains the boundary if that changes.
const LOOPBACK_BROWSER_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
const ALLOWED_PREFLIGHT_METHODS = new Set(["GET", "POST"]);

export function isLoopbackBrowserOrigin(origin: string | null | undefined): origin is string {
  return typeof origin === "string" && LOOPBACK_BROWSER_ORIGIN_RE.test(origin);
}

export function corsPreflightResponse(req: Request, origin: string | null): Response | null {
  const requestedMethod = req.headers.get("access-control-request-method");
  if (
    req.method !== "OPTIONS" ||
    !isLoopbackBrowserOrigin(origin) ||
    requestedMethod === null ||
    !ALLOWED_PREFLIGHT_METHODS.has(requestedMethod)
  ) {
    return null;
  }

  const headers = new Headers();
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "600");
  headers.set("vary", "Origin");

  return new Response(null, { status: 204, headers });
}

export function withCorsResponseHeaders(origin: string | null, response: Response): Response {
  if (isLoopbackBrowserOrigin(origin)) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("access-control-allow-credentials", "true");
    // Access-Control-Expose-Headers stays omitted until a browser caller needs it.
  }
  const vary = response.headers.get("vary");
  if (vary === null) {
    response.headers.set("vary", "Origin");
  } else if (!vary.split(",").some((value) => value.trim().toLowerCase() === "origin")) {
    response.headers.set("vary", `${vary}, Origin`);
  }

  return response;
}
