/**
 * Type-only stand-ins for the @penumbra/* shapes the extracted adapter tests
 * import. These are host-side contracts, redeclared here so the parity suite
 * compiles without any runtime dependency on penumbra packages.
 */

export interface DispatchEventInput {
  handoff_id: string;
  worker_id?: string;
  source: string;
  kind: string;
  ts: string;
  meta?: Record<string, unknown>;
}

export type DispatchEvent =
  | { type: "delta"; text: string }
  | { type: "done"; result: { text: string } };

export interface RecordThoughtInput {
  handoffId: string;
  adapter: string;
  agentName: string;
  text: string;
}

/** Class-shaped surface: tests launder partial mocks through `as unknown as`. */
export interface ThoughtCapture {
  recordThought(input: RecordThoughtInput): void;
}

export interface McpServerStdio {
  name: string;
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
}

export interface CapturePort {
  emit(event: DispatchEventInput): void;
}
