import { spawn, type ChildProcess } from 'node:child_process';
import type { DispatchEvent } from '../sdk/adapter.js';

export interface SpawnOpts {
  command: string;
  args: string[];
  prompt: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  /** Names of inherited env vars to drop before spawning (e.g. when an inherited OPENAI_BASE_URL would override the CLI's own auth). */
  unset_env?: string[];
  cwd?: string;
  pass_via?: 'stdin' | 'argv';
  /** Regex patterns whose matching output lines are removed before returning. Useful for CLIs whose own hook/wrapper code prints chatty noise around the model reply. */
  strip_patterns?: string[];
  /** Optional callback fired when a vendor capacity-error pattern is detected in stderr. */
  onCapacityError?: (err: CapacityError) => void;
}

const CAPACITY_PATTERNS: Array<{ provider: string; re: RegExp }> = [
  { provider: 'google', re: /No capacity available for model ([\w.\-]+)/ },
];

export interface CapacityError {
  provider: string;
  model: string | null;
  raw: string;
}

export function detectCapacityError(stderr: string): CapacityError | null {
  if (!stderr) return null;
  for (const p of CAPACITY_PATTERNS) {
    const m = stderr.match(p.re);
    if (m) {
      return { provider: p.provider, model: m[1] ?? null, raw: m[0] };
    }
  }
  return null;
}

const DEFAULT_CANCEL_GRACE_S = 10;
const DEFAULT_DISPATCH_TIMEOUT_S = 900;

function applyStripPatterns(text: string, patterns: string[] | undefined): string {
  if (!patterns || patterns.length === 0) return text;
  const compiled = patterns.map((p) => new RegExp(p));
  const lines = text.split('\n');
  const kept = lines.filter((line) => !compiled.some((re) => re.test(line)));
  return kept.join('\n');
}

function readCancelGraceMs(raw?: string): number {
  if (raw == null || raw.trim() === '') return DEFAULT_CANCEL_GRACE_S * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CANCEL_GRACE_S * 1000;
  return parsed * 1000;
}

function readDispatchTimeoutMs(raw?: string): number {
  if (raw == null || raw.trim() === '') return DEFAULT_DISPATCH_TIMEOUT_S * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISPATCH_TIMEOUT_S * 1000;
  return parsed * 1000;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function spawnProcess(opts: {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  stdinMode: 'ignore' | 'pipe';
}): ChildProcess {
  return spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdinMode, 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
  });
}

function killProcessTree(proc: ChildProcess, kind: NodeJS.Signals): void {
  if (!proc.pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-proc.pid, kind);
    } else {
      proc.kill(kind);
    }
  } catch {
    // Process may already be gone.
  }
}

async function writePrompt(stdin: NodeJS.WritableStream | null | undefined, prompt: string): Promise<void> {
  if (!stdin) return;
  await new Promise<void>((resolve, reject) => {
    stdin.once('error', reject);
    stdin.write(prompt, (err) => {
      if (err) {
        reject(err);
        return;
      }
      stdin.end((endErr?: Error | null) => {
        if (endErr) reject(endErr);
        else resolve();
      });
    });
  });
}

async function readStreamText(stream: NodeJS.ReadableStream | null | undefined): Promise<string> {
  if (!stream) return '';
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function waitForExit(proc: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export async function* spawnCliAdapterStream(opts: SpawnOpts): AsyncGenerator<DispatchEvent> {
  const isArgv = opts.pass_via === 'argv';
  const finalArgs = isArgv ? [...opts.args, opts.prompt] : opts.args;

  const mergedEnv: Record<string, string> = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
  for (const key of opts.unset_env ?? []) delete mergedEnv[key];

  const cancelGraceMs = readCancelGraceMs(opts.env?.PENUMBRA_CANCEL_GRACE_S ?? process.env.PENUMBRA_CANCEL_GRACE_S);
  const dispatchTimeoutMs = readDispatchTimeoutMs(
    opts.env?.PENUMBRA_DISPATCH_TIMEOUT_S ?? process.env.PENUMBRA_DISPATCH_TIMEOUT_S,
  );

  const proc = spawnProcess({
    command: opts.command,
    args: finalArgs,
    env: mergedEnv,
    cwd: opts.cwd,
    stdinMode: isArgv ? 'ignore' : 'pipe',
  });

  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const onAbort = () => {
    killProcessTree(proc, 'SIGTERM');
    cancelTimer = setTimeout(() => killProcessTree(proc, 'SIGKILL'), cancelGraceMs);
  };

  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener('abort', onAbort, { once: true });

  if (!isArgv) {
    await writePrompt(proc.stdin, opts.prompt);
  }

  const dispatchTimer = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc, 'SIGKILL');
  }, dispatchTimeoutMs);

  // Start collecting stderr in parallel so it doesn't block stdout consumption.
  const stderrPromise = readStreamText(proc.stderr);

  let collected = '';
  // Stateful decoder handles multi-byte chars split across chunk boundaries.
  const decoder = new TextDecoder('utf-8', { fatal: false });

  try {
    for await (const chunk of proc.stdout ?? []) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) {
        collected += text;
        yield { type: 'delta', text };
      }
      if (opts.signal.aborted || timedOut) break;
    }

    // Flush any remaining bytes held by the stateful decoder.
    const tail = decoder.decode();
    if (tail) {
      collected += tail;
      yield { type: 'delta', text: tail };
    }

    if (timedOut) {
      throw new Error(`${opts.command}: dispatch exceeded ${dispatchTimeoutMs}ms (watchdog)`);
    }

    if (opts.signal.aborted) {
      yield { type: 'done', result: { text: applyStripPatterns(collected, opts.strip_patterns) } };
      return;
    }

    const [stderr, exit] = await Promise.all([stderrPromise, waitForExit(proc)]);

    const capErr = detectCapacityError(stderr);
    if (capErr && opts.onCapacityError) {
      try { opts.onCapacityError(capErr); } catch { /* Callback failures must not break the spawn return path. */ }
    }

    const finalText = applyStripPatterns(collected, opts.strip_patterns);

    if (exit.signal) {
      throw new Error(`${opts.command}: signal ${exit.signal}${stderr ? ` — ${stderr}` : ''}`);
    }

    if (exit.code === 0 && !finalText.trim() && stderr.trim()) {
      throw new Error(`${opts.command}: empty output — ${stderr.trim().slice(0, 500)}`);
    }

    yield { type: 'done', result: { text: finalText } };

    if (exit.code !== 0) {
      throw new Error(`${opts.command}: exit code ${exit.code}${stderr ? ` — ${stderr}` : ''}`);
    }
  } finally {
    clearTimeout(dispatchTimer);
    if (cancelTimer !== null) clearTimeout(cancelTimer);
    opts.signal.removeEventListener('abort', onAbort);
  }
}

export async function spawnCliAdapter(opts: SpawnOpts): Promise<{ text: string; stderr: string }> {
  const isArgv = opts.pass_via === 'argv';
  const finalArgs = isArgv ? [...opts.args, opts.prompt] : opts.args;

  const mergedEnv: Record<string, string> = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
  for (const key of opts.unset_env ?? []) delete mergedEnv[key];

  const cancelGraceMs = readCancelGraceMs(opts.env?.PENUMBRA_CANCEL_GRACE_S ?? process.env.PENUMBRA_CANCEL_GRACE_S);
  const dispatchTimeoutMs = readDispatchTimeoutMs(opts.env?.PENUMBRA_DISPATCH_TIMEOUT_S ?? process.env.PENUMBRA_DISPATCH_TIMEOUT_S);
  const proc = spawnProcess({
    command: opts.command,
    args: finalArgs,
    env: mergedEnv,
    cwd: opts.cwd,
    stdinMode: isArgv ? 'ignore' : 'pipe',
  });

  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    killProcessTree(proc, 'SIGTERM');
    cancelTimer = setTimeout(() => killProcessTree(proc, 'SIGKILL'), cancelGraceMs);
  };

  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener('abort', onAbort, { once: true });

  if (!isArgv) {
    await writePrompt(proc.stdin, opts.prompt);
  }

  // Watchdog: bound the total dispatch in case the child writes nothing
  // and proc.exited never resolves (observed under Bun 1.3.13 when a child
  // tree dies in some races). On timeout, SIGKILL the proc and reject so
  // the worker frees up instead of waiting forever.
  let dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  const watchdog = new Promise<never>((_, reject) => {
    dispatchTimer = setTimeout(() => {
      killProcessTree(proc, 'SIGKILL');
      reject(new Error(`${opts.command}: dispatch exceeded ${dispatchTimeoutMs}ms (watchdog)`));
    }, dispatchTimeoutMs);
  });

  try {
    const result = await Promise.race([
      (async () => {
        const [rawText, stderr, code] = await Promise.all([
          readStreamText(proc.stdout),
          readStreamText(proc.stderr),
          waitForExit(proc),
        ]);
        const capErr = detectCapacityError(stderr);
        if (capErr && opts.onCapacityError) {
          try {
            opts.onCapacityError(capErr);
          } catch {
            // Callback failures must not break the spawn return path.
          }
        }
        return { rawText, stderr, exit: code };
      })(),
      watchdog,
    ]);
    if (opts.signal.aborted) {
      throw new Error(`${opts.command}: aborted`);
    }
    if (result.exit.signal) {
      throw new Error(`${opts.command}: signal ${result.exit.signal}${result.stderr ? ` — ${result.stderr}` : ''}`);
    }
    if (result.exit.code !== 0) {
      throw new Error(`${opts.command}: exit code ${result.exit.code}${result.stderr ? ` — ${result.stderr}` : ''}`);
    }
    return {
      text: applyStripPatterns(result.rawText, opts.strip_patterns),
      stderr: result.stderr,
    };
  } finally {
    if (dispatchTimer) clearTimeout(dispatchTimer);
    if (cancelTimer) clearTimeout(cancelTimer);
    opts.signal.removeEventListener('abort', onAbort);
  }
}
