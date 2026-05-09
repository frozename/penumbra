import { existsSync, readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ConsoleCommandOpts {
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

export interface PreparedConsoleServer {
  url: string;
  port: number;
  stop: () => void;
}

interface DaemonBootstrap {
  baseUrl: string;
  token: string;
}

class ConsoleCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleCommandError';
  }
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveStorageRoot(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.PENUMBRA_STORAGE_ROOT) return process.env.PENUMBRA_STORAGE_ROOT;
  return join(homedir(), '.penumbra');
}

function readDaemonBootstrap(storageRoot: string): DaemonBootstrap {
  const tokenPath = join(storageRoot, 'token');
  if (!existsSync(tokenPath)) {
    throw new ConsoleCommandError(`no token found at ${tokenPath}; run \`penumbra init\` first`);
  }
  const portPath = join(storageRoot, 'port');
  if (!existsSync(portPath)) {
    throw new ConsoleCommandError(`no daemon port at ${portPath}; run \`penumbra start\` first`);
  }
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!token) {
    throw new ConsoleCommandError(`empty token at ${tokenPath}; run \`penumbra init\` first`);
  }
  const portRaw = readFileSync(portPath, 'utf8').trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConsoleCommandError(`invalid daemon port in ${portPath}: ${portRaw}`);
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

function findRepoRoot(start: string): string | null {
  let cur = start;
  for (let i = 0; i < 12; i++) {
    const pkgPath = join(cur, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'penumbra') return cur;
      } catch { /* fall through */ }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function resolveDistPath(explicit: string | undefined): string {
  if (explicit) return resolve(explicit);
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  if (!repoRoot) {
    throw new ConsoleCommandError('could not locate repo root from CLI install path');
  }
  const dist = join(repoRoot, 'packages/console/dist');
  if (!existsSync(join(dist, 'index.html'))) {
    const r = spawnSync('bun', ['--cwd', join(repoRoot, 'packages/console'), 'run', 'build'], {
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      throw new ConsoleCommandError(`bun build for packages/console failed (exit ${r.status})`);
    }
    if (!existsSync(join(dist, 'index.html'))) {
      throw new ConsoleCommandError(`build completed but ${join(dist, 'index.html')} is missing`);
    }
  }
  return dist;
}

function buildInjectedHtml(distPath: string, daemon: DaemonBootstrap): string {
  const indexPath = join(distPath, 'index.html');
  if (!existsSync(indexPath)) {
    throw new ConsoleCommandError(`index.html not found at ${indexPath}`);
  }
  const raw = readFileSync(indexPath, 'utf8');
  const configJson = JSON.stringify({ baseUrl: daemon.baseUrl, token: daemon.token });
  // Verify round-trip parse before embedding.
  JSON.parse(configJson);
  const escaped = htmlEscape(configJson);
  const replaced = raw.replace(
    /<meta\s+name="penumbra-config"\s+content=""\s*\/?>/,
    `<meta name="penumbra-config" content='${escaped}'>`,
  );
  if (replaced === raw) {
    throw new ConsoleCommandError(
      `placeholder <meta name="penumbra-config" content=""> not found in ${indexPath}`,
    );
  }
  return replaced;
}

function safeJoin(root: string, requested: string): string | null {
  // Strip drive letters / leading slashes; treat as a relative path under root.
  let rel = requested.replace(/\\/g, '/');
  if (rel.startsWith('/')) rel = rel.slice(1);
  const candidate = normalize(join(root, rel));
  const rootNorm = normalize(root);
  if (candidate !== rootNorm && !candidate.startsWith(rootNorm + sep)) {
    return null;
  }
  return candidate;
}

export function prepareConsoleServer(opts: ConsoleCommandOpts): PreparedConsoleServer {
  const storageRoot = resolveStorageRoot(opts.storageRoot);
  const daemon = readDaemonBootstrap(storageRoot);
  const distPath = resolveDistPath(opts.distPath);
  const injectedHtml = buildInjectedHtml(distPath, daemon);
  const distNorm = normalize(distPath);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    fetch(req) {
      const url = new URL(req.url);
      const requested = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = safeJoin(distNorm, requested);
      if (!file) return new Response('forbidden', { status: 403 });
      if (file === join(distNorm, 'index.html')) {
        return new Response(injectedHtml, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (!existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(Bun.file(file));
    },
  });

  const port = server.port ?? (opts.port ?? 0);
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    port,
    stop: () => { server.stop(); },
  };
}

function openBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
    child.on('error', () => { /* opener failure is non-fatal */ });
  } catch { /* non-fatal */ }
}

export async function runConsole(opts: ConsoleCommandOpts): Promise<{ exitCode: number }> {
  const stdout = opts._stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = opts._stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let prepared: PreparedConsoleServer;
  try {
    prepared = prepareConsoleServer(opts);
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
    openBrowser(prepared.url);
  }

  if (opts._testReturnImmediately) {
    prepared.stop();
    return { exitCode: 0 };
  }

  await new Promise<void>((resolveSignal) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      prepared.stop();
      resolveSignal();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return { exitCode: 0 };
}
