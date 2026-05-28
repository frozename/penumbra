import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PrepareConsoleServerOpts {
  port?: number;
  noOpen?: boolean;
  storageRoot?: string;
  distPath?: string;
  /** Internal: bind, log, then immediately stop and return. Used by tests. */
  _testReturnImmediately?: boolean;
  /** Internal stdout sink for tests. */
  _stdout?: (line: string) => void;
  /** Internal stderr sink for tests. */
  _stderr?: (line: string) => void;
}

// Back-compat alias for callers still importing the old name.
export type ConsoleCommandOpts = PrepareConsoleServerOpts;

export interface PreparedConsoleServer {
  port: number;
  url: string;
  sessionNonce: string;
  stop: () => Promise<void>;
}

interface DaemonBootstrap {
  port(): number;
  token(): string;
  refresh(): boolean;
}

interface DaemonBootstrapSnapshot {
  port: number;
  token: string;
}

class ConsoleCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleCommandError";
  }
}

const SESSION_COOKIE = "penumbra_session";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function applySecurityHeaders(h: Headers): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    h.set(k, v);
  }
}

function resolveStorageRoot(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.PENUMBRA_STORAGE_ROOT) return process.env.PENUMBRA_STORAGE_ROOT;
  return join(homedir(), ".penumbra");
}

function readDaemonBootstrap(storageRoot: string): DaemonBootstrapSnapshot {
  const tokenPath = join(storageRoot, "token");
  if (!existsSync(tokenPath)) {
    throw new ConsoleCommandError(`no token found at ${tokenPath}; run \`penumbra init\` first`);
  }
  const portPath = join(storageRoot, "port");
  if (!existsSync(portPath)) {
    throw new ConsoleCommandError(`no daemon port at ${portPath}; run \`penumbra start\` first`);
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) {
    throw new ConsoleCommandError(`empty token at ${tokenPath}; run \`penumbra init\` first`);
  }
  const portRaw = readFileSync(portPath, "utf8").trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConsoleCommandError(`invalid daemon port in ${portPath}: ${portRaw}`);
  }
  return { port, token };
}

class FileDaemonBootstrap implements DaemonBootstrap {
  private daemonPort: number;
  private daemonToken: string;
  private lastRefreshAt = 0;

  constructor(private readonly storageRoot: string) {
    const snapshot = readDaemonBootstrap(storageRoot);
    this.daemonPort = snapshot.port;
    this.daemonToken = snapshot.token;
  }

  port(): number {
    return this.daemonPort;
  }

  token(): string {
    return this.daemonToken;
  }

  refresh(): boolean {
    const now = Date.now();
    if (now - this.lastRefreshAt < 5000) return false;
    this.lastRefreshAt = now;

    let snapshot: DaemonBootstrapSnapshot;
    try {
      snapshot = readDaemonBootstrap(this.storageRoot);
    } catch {
      return false;
    }

    const changed = snapshot.port !== this.daemonPort || snapshot.token !== this.daemonToken;
    if (!changed) return false;
    this.daemonPort = snapshot.port;
    this.daemonToken = snapshot.token;
    return true;
  }
}

function findRepoRoot(start: string): string | null {
  let cur = start;
  for (let i = 0; i < 12; i++) {
    const pkgPath = join(cur, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "penumbra") return cur;
      } catch {
        /* fall through */
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function resolveDistPath(explicit: string | undefined): string {
  if (explicit) return resolve(explicit);
  if (process.env.PENUMBRA_CONSOLE_DIST) return resolve(process.env.PENUMBRA_CONSOLE_DIST);
  const argvPath = process.argv[1];
  if (argvPath) {
    const adjacent = join(dirname(argvPath), "console-dist");
    if (existsSync(join(adjacent, "index.html"))) return adjacent;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  if (!repoRoot) {
    throw new ConsoleCommandError(
      "could not locate console assets: pass distPath, set PENUMBRA_CONSOLE_DIST, or run from a penumbra checkout",
    );
  }
  return join(repoRoot, "packages/console/dist");
}

function ensureDistReady(distPath: string): void {
  const indexPath = join(distPath, "index.html");
  if (!existsSync(distPath) || !existsSync(indexPath)) {
    throw new ConsoleCommandError(
      `Console assets not found at ${distPath}.\nRun \`bun --cwd packages/console run build\` first.`,
    );
  }
}

function safeJoin(root: string, requested: string): string | null {
  let rel = requested.replace(/\\/g, "/");
  if (rel.startsWith("/")) rel = rel.slice(1);
  const candidate = normalize(join(root, rel));
  const rootNorm = normalize(root);
  if (candidate !== rootNorm && !candidate.startsWith(rootNorm + sep)) {
    return null;
  }
  return candidate;
}

function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out.set(k, v);
  }
  return out;
}

function filterUpstreamHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    if (lk === "set-cookie") return;
    if (lk === "authorization") return;
    out.set(key, value);
  });
  applySecurityHeaders(out);
  return out;
}

function setProxyVary(headers: Headers): void {
  headers.set("Vary", "Origin, Sec-Fetch-Site");
}

function isMutatingMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function makeUpstreamRequestInit(
  req: Request,
  token: string,
  body: ArrayBuffer | undefined,
): RequestInit {
  const fwdHeaders = new Headers();
  req.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    if (lk === "cookie") return;
    if (lk === "host") return;
    if (lk === "authorization") return;
    if (lk === "content-length") return;
    fwdHeaders.set(key, value);
  });
  fwdHeaders.set("Authorization", `Bearer ${token}`);

  const init: RequestInit = {
    method: req.method,
    headers: fwdHeaders,
    redirect: "manual",
  };
  if (body !== undefined) {
    init.body = body;
    // Bun/undici streaming requires this to allow request bodies to flow.
    (init as RequestInit & { duplex?: string }).duplex = "half";
  }
  return init;
}

async function fetchUpstream(
  req: Request,
  targetPath: string,
  daemon: DaemonBootstrap,
  body: ArrayBuffer | undefined,
): Promise<{ upstream: Response | null; error: Error | null }> {
  const targetUrl = `http://127.0.0.1:${daemon.port()}${targetPath || "/"}`;
  const init = makeUpstreamRequestInit(req, daemon.token(), body);
  try {
    const upstream = await fetch(targetUrl, init);
    return { upstream, error: null };
  } catch (error) {
    return { upstream: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function strictIndexCsp(html: string): string {
  return html.replace(
    "connect-src 'self' http://127.0.0.1:* http://localhost:*",
    "connect-src 'self'",
  );
}

async function proxyToDaemon(req: Request, url: URL, daemon: DaemonBootstrap): Promise<Response> {
  const targetPath = url.pathname.replace(/^\/api/, "") + url.search;
  const body = req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined;

  let attempt = await fetchUpstream(req, targetPath, daemon, body);
  const shouldRetry =
    attempt.error !== null ||
    (attempt.upstream !== null &&
      (attempt.upstream.status === 401 || attempt.upstream.status === 403));
  if (shouldRetry && daemon.refresh()) {
    attempt = await fetchUpstream(req, targetPath, daemon, body);
  }

  if (attempt.error) {
    const headers = new Headers({ "content-type": "application/json" });
    applySecurityHeaders(headers);
    setProxyVary(headers);
    return new Response(
      JSON.stringify({ error: "upstream_unreachable", message: attempt.error.message }),
      { status: 502, headers },
    );
  }

  const headers = filterUpstreamHeaders(attempt.upstream!.headers);
  setProxyVary(headers);
  return new Response(attempt.upstream!.body, {
    status: attempt.upstream!.status,
    statusText: attempt.upstream!.statusText,
    headers,
  });
}

function jsonError(status: number, body: unknown): Response {
  const headers = new Headers({ "content-type": "application/json" });
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(body), { status, headers });
}

export async function prepareConsoleServer(
  opts: PrepareConsoleServerOpts,
): Promise<PreparedConsoleServer> {
  const storageRoot = resolveStorageRoot(opts.storageRoot);
  const daemon = new FileDaemonBootstrap(storageRoot);
  const distPath = resolveDistPath(opts.distPath);
  ensureDistReady(distPath);
  const distNorm = normalize(distPath);
  const sessionNonce = randomBytes(32).toString("hex");
  let cachedStrictIndex: string | null = null;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const cookies = parseCookies(req.headers.get("cookie"));
        if (cookies.get(SESSION_COOKIE) !== sessionNonce) {
          return jsonError(401, { error: "invalid_session" });
        }
        if (isMutatingMethod(req.method)) {
          const secFetchSite = req.headers.get("sec-fetch-site");
          const requestOrigin = req.headers.get("origin");
          const expectedOrigin = `${url.protocol}//${url.host}`;
          if (secFetchSite !== "same-origin" || requestOrigin !== expectedOrigin) {
            const res = jsonError(403, { error: "cross_site_request_forbidden" });
            setProxyVary(res.headers);
            return res;
          }
        }
        return proxyToDaemon(req, url, daemon);
      }

      const requested = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = safeJoin(distNorm, requested);
      if (!file) {
        const headers = new Headers({ "content-type": "text/plain" });
        applySecurityHeaders(headers);
        return new Response("forbidden", { status: 403, headers });
      }
      const isIndex = file === join(distNorm, "index.html");
      if (!isIndex && !existsSync(file)) {
        const headers = new Headers({ "content-type": "text/plain" });
        applySecurityHeaders(headers);
        return new Response("not found", { status: 404, headers });
      }

      if (isIndex) {
        if (cachedStrictIndex === null) {
          cachedStrictIndex = strictIndexCsp(readFileSync(file, "utf8"));
        }
        const headers = new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": `${SESSION_COOKIE}=${sessionNonce}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        });
        applySecurityHeaders(headers);
        return new Response(cachedStrictIndex, { headers });
      }

      const headers = new Headers();
      applySecurityHeaders(headers);
      return new Response(Bun.file(file), { headers });
    },
  });

  const port = server.port ?? opts.port ?? 0;
  const url = `http://127.0.0.1:${port}`;
  return {
    port,
    url,
    sessionNonce,
    async stop() {
      server.stop();
    },
  };
}

function openBrowser(url: string, stderr: (line: string) => void): void {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
    child.on("error", (err) => {
      stderr(`Could not open browser automatically. Visit ${url} manually. (${err.message})`);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Could not open browser automatically. Visit ${url} manually. (${msg})`);
  }
}

export async function runConsole(opts: PrepareConsoleServerOpts): Promise<{ exitCode: number }> {
  const stdout = opts._stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = opts._stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let prepared: PreparedConsoleServer;
  try {
    prepared = await prepareConsoleServer(opts);
  } catch (err) {
    if (err instanceof ConsoleCommandError) {
      stderr(err.message);
      return { exitCode: 1 };
    }
    stderr(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  stdout(`Operator console: ${prepared.url}`);

  if (!opts.noOpen) {
    openBrowser(prepared.url, stderr);
  }

  if (opts._testReturnImmediately) {
    await prepared.stop();
    return { exitCode: 0 };
  }

  await new Promise<void>((resolveSignal) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await prepared.stop();
      resolveSignal();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return { exitCode: 0 };
}
