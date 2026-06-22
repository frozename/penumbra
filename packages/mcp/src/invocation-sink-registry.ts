import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  type InvocationSink,
  type InvocationSinkOptions,
  openInvocationSink,
} from "./invocation-sink.js";

const DEFAULT_OPTIONS: Readonly<InvocationSinkOptions> = Object.freeze({});

/**
 * Resolves the XDG state-dir path for the invocation log. Treats `XDG_STATE_HOME=""`
 * as unset per the XDG spec; `path.resolve` so a relative value never lets writes
 * land in the process CWD.
 */
export function resolveDefaultInvocationLogPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_STATE_HOME;
  const stateHome = xdg !== undefined && xdg !== "" ? xdg : join(home, ".local", "state");
  return resolve(stateHome, "penumbra", "mcp-invocations.jsonl");
}

let activeSink: InvocationSink | null = null;
let closing: Promise<void> | null = null;

/**
 * Opens the per-process singleton sink. Throws if already initialized — every
 * misconfigured second caller would otherwise silently inherit the first
 * caller's path/options.
 *
 * Sink-open failure (permissions, disk full) propagates here; the daemon's
 * startup path treats that as a fail-closed init error. Runtime sink errors
 * after open are swallowed by the underlying stream's 'error' handler.
 */
export async function initSink(
  path: string,
  options: Readonly<InvocationSinkOptions> = DEFAULT_OPTIONS,
): Promise<InvocationSink> {
  if (closing !== null) await closing;
  if (activeSink !== null) {
    throw new Error("initSink: invocation sink is already initialized; call closeSink first");
  }
  activeSink = openInvocationSink(path, options);
  return activeSink;
}

/**
 * Returns the singleton sink. Throws if `initSink` has not been called or if a
 * close is in progress, so a no-op call site can't silently miss writes.
 */
export function getSink(): InvocationSink {
  if (closing !== null) {
    throw new Error("getSink: invocation sink is closing; await closeSink before reopening");
  }
  if (activeSink === null) {
    throw new Error("getSink: invocation sink not initialized; call initSink first");
  }
  return activeSink;
}

/**
 * Closes the singleton and clears the slot. Concurrent callers share a single
 * close promise — `initSink` awaits it so a second writer can't open the same
 * file while the first is still flushing.
 */
export function closeSink(): Promise<void> {
  if (closing !== null) return closing;
  if (activeSink === null) return Promise.resolve();
  const sink = activeSink;
  closing = sink.close().finally(() => {
    activeSink = null;
    closing = null;
  });
  return closing;
}
