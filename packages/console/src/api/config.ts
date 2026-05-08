// Daemon credentials live ONLY in the meta-tag injected by `penumbra console`
// at serve time (Task 6.1). The bundle MUST NOT contain a token. Dev mode reads
// from Vite-injected env vars, gated to loopback hosts. Origin/Host validation
// at the daemon (P0.0) is the second layer; CSP is the third.

export class BadDaemonUrlError extends Error {
  override name = "BadDaemonUrlError";
}

export class MissingTokenError extends Error {
  override name = "MissingTokenError";
}

export interface PenumbraConfig {
  baseUrl: string;
  token: string;
}

export interface LoadDeps {
  doc?: Document;
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

function readMeta(doc: Document | undefined): PenumbraConfig | null {
  if (!doc) return null;
  const el = doc.querySelector('meta[name="penumbra-config"]');
  if (!el) return null;
  const content =
    typeof (el as Element & { getAttribute: (n: string) => string | null })
      .getAttribute === "function"
      ? (el as Element).getAttribute("content")
      : null;
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as Partial<PenumbraConfig>;
    if (
      typeof parsed.baseUrl === "string" &&
      typeof parsed.token === "string"
    ) {
      return { baseUrl: parsed.baseUrl, token: parsed.token };
    }
  } catch {
    return null;
  }
  return null;
}

export function loadPenumbraConfig(deps: LoadDeps = {}): PenumbraConfig {
  const doc =
    deps.doc !== undefined
      ? deps.doc
      : typeof document !== "undefined"
        ? document
        : undefined;
  const devToken =
    deps.devToken ??
    (typeof __PENUMBRA_DEV_TOKEN__ !== "undefined" ? __PENUMBRA_DEV_TOKEN__ : "");
  const devUrl =
    deps.devUrl ??
    (typeof __PENUMBRA_DEV_DAEMON_URL__ !== "undefined"
      ? __PENUMBRA_DEV_DAEMON_URL__
      : "");

  const fromMeta = readMeta(doc);
  const baseUrl = fromMeta?.baseUrl ?? devUrl;
  const token = fromMeta?.token ?? devToken;

  if (!isLoopbackBaseUrl(baseUrl)) {
    throw new BadDaemonUrlError(
      `daemon baseUrl "${baseUrl}" is not loopback (http://127.0.0.1[:port] or http://localhost[:port])`,
    );
  }

  if (!token) {
    throw new MissingTokenError("penumbra daemon token is missing");
  }

  return { baseUrl: normalizeBaseUrl(baseUrl), token };
}
