import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  openInvocationSink,
  type InvocationSink,
  type InvocationSinkOptions,
} from './invocation-sink.js';

function defaultPath(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(stateHome, 'penumbra', 'mcp-invocations.jsonl');
}

let sinkSingleton: InvocationSink | null = null;

export function getSink(
  resolvePath: () => string = defaultPath,
  options: InvocationSinkOptions = {},
): InvocationSink {
  if (sinkSingleton === null) {
    sinkSingleton = openInvocationSink(resolvePath(), options);
  }
  return sinkSingleton;
}

export async function closeSink(): Promise<void> {
  if (sinkSingleton === null) {
    return;
  }
  const sink = sinkSingleton;
  sinkSingleton = null;
  await sink.close();
}

export function _resetSinkForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetSinkForTest is test-only');
  }
  sinkSingleton = null;
}
