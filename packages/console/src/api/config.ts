export class BadDaemonUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadDaemonUrlError";
  }
}

export class MissingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingTokenError";
  }
}

export interface PenumbraConfig {
  baseUrl: string;
  /**
   * Production: empty string (auth carried by HttpOnly cookie).
   * Dev: a token from the Vite-injected env (talking directly to a local daemon).
   * Consumers MUST NOT rely on this being non-empty in production.
   */
  token: string;
}

export interface LoadDeps {
  isDev?: boolean;
  devToken?: string;
  devUrl?: string;
}

function isLoopbackBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:") return false;
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return false;
    if (u.username || u.password) return false;
    if (u.pathname !== "" && u.pathname !== "/") return false;
    if (u.search || u.hash) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * In production: returns { baseUrl: '/api', token: '' }. The launcher
 * (`penumbra console`) reverse-proxies /api/* to the daemon and attaches
 * the bearer token server-side. The browser never sees the token.
 *
 * In dev (Vite serve, no launcher): returns { baseUrl: <dev daemon url>, token: <dev token> }.
 * The dev path is for local development only; no launcher proxy.
 */
export function loadPenumbraConfig(deps?: LoadDeps): PenumbraConfig {
  const isDev = deps?.isDev ?? import.meta.env.DEV;

  if (!isDev) {
    return { baseUrl: "/api", token: "" };
  }

  const devUrl = deps?.devUrl ?? import.meta.env.PENUMBRA_DAEMON_URL ?? "";
  const devToken = deps?.devToken ?? import.meta.env.PENUMBRA_TOKEN ?? "";

  if (!isLoopbackBaseUrl(devUrl)) {
    throw new BadDaemonUrlError(`dev daemon URL must be loopback, got: ${devUrl}`);
  }
  if (!devToken) {
    throw new MissingTokenError("PENUMBRA_TOKEN is required in dev mode");
  }
  return { baseUrl: normalizeBaseUrl(devUrl), token: devToken };
}
