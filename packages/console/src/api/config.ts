export class BadDaemonUrlError extends Error {
  override name = "BadDaemonUrlError";
}

export class MissingTokenError extends Error {
  override name = "MissingTokenError";
}

const ALLOWLIST = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

export interface PenumbraConfig {
  baseUrl: string;
  token: string;
}

export interface LoadDeps {
  doc?: Document;
  env?: Record<string, string | undefined>;
  devToken?: string;
  devUrl?: string;
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
  const env =
    deps.env ??
    (typeof import.meta !== "undefined"
      ? ((import.meta as unknown as { env?: Record<string, string | undefined> })
          .env ?? {})
      : {});
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

  if (!ALLOWLIST.test(baseUrl)) {
    if (env.VITE_PENUMBRA_ALLOW_REMOTE === "1") {
      console.warn(
        `[penumbra-console] non-loopback daemon URL "${baseUrl}" allowed via VITE_PENUMBRA_ALLOW_REMOTE`,
      );
    } else {
      throw new BadDaemonUrlError(
        `daemon baseUrl "${baseUrl}" is not loopback; set VITE_PENUMBRA_ALLOW_REMOTE=1 to override`,
      );
    }
  }

  if (!token) {
    throw new MissingTokenError("penumbra daemon token is missing");
  }

  return { baseUrl, token };
}
