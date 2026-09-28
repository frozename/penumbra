import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { expect } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { DispatchEvent } from "../src/shim/types.js";
import type { RecordThoughtInput, ThoughtCapture } from "../src/shim/types.js";

export async function expectRejection(
  promise: Promise<unknown>,
  matcher?: RegExp | string,
): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  const message = caught instanceof Error ? caught.message : String(caught);
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    expect(matcher.test(message)).toBe(true);
  } else if (typeof matcher === "string") {
    expect(message).toContain(matcher);
  }
  return caught instanceof Error ? caught : new Error(message);
}

/**
 * Build a passthrough ThoughtCapture stub for tests that just want to observe
 * recordThought calls. Constructing a real ThoughtCapture would apply
 * redaction/byte caps that interfere with these adapter-level assertions.
 * The single `as unknown as` cast launders the partial mock through the
 * class type — the documented test-double escape hatch.
 */
export function makeThoughtCaptureStub(
  onRecord: (input: RecordThoughtInput) => void,
): ThoughtCapture {
  return { recordThought: onRecord } as unknown as ThoughtCapture;
}

export interface MockChildProcessInit {
  pid?: number;
  stdout: AsyncIterable<Buffer>;
  onKill: (signal: NodeJS.Signals, proc: MockProcHandle) => boolean;
}

export interface MockProcHandle {
  emit: (event: string, ...args: unknown[]) => boolean;
  stdin: PassThrough;
  stderr: PassThrough;
  signalCode: NodeJS.Signals | null;
}

/**
 * Build a minimal ChildProcess-shaped mock for spyOn(childProcess, "spawn").
 * The default spawn() overload (pipe stdio) returns ChildProcessWithoutNullStreams,
 * which is a nominal class with private fields, so a structural mock requires
 * a single launder through `as unknown as ChildProcessWithoutNullStreams`.
 */
export function makeMockChildProcess(init: MockChildProcessInit): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter();
  const proc = emitter as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdin: PassThrough;
    stderr: PassThrough;
    stdout: AsyncIterable<Buffer>;
    kill: (signal: NodeJS.Signals) => boolean;
  };
  proc.pid = init.pid ?? 1234;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stdin = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdout = init.stdout;
  const handle: MockProcHandle = {
    emit: (event, ...args) => emitter.emit(event, ...args),
    stdin: proc.stdin,
    stderr: proc.stderr,
    get signalCode(): NodeJS.Signals | null {
      return proc.signalCode;
    },
    set signalCode(value: NodeJS.Signals | null) {
      proc.signalCode = value;
    },
  };
  proc.kill = (signal: NodeJS.Signals): boolean => init.onKill(signal, handle);
  return proc as unknown as ChildProcessWithoutNullStreams;
}

export function assertDoneEvent(
  event: DispatchEvent | undefined,
): Extract<DispatchEvent, { type: "done" }> {
  if (event?.type !== "done") {
    throw new Error(`expected done event, got ${event?.type ?? "undefined"}`);
  }
  return event;
}
