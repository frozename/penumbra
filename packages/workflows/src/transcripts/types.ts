export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
};

export type TranscriptReadResult =
  | {
      status: "ok";
      sessionId: string;
      cwd: string;
      messages: TranscriptMessage[];
      truncated: boolean;
      contextTokens: null;
    }
  | { status: "unsupported"; reason: string }
  | { status: "identity_mismatch"; reason: string }
  | { status: "unavailable"; reason: string };

export type ExpectedFileIdentity = {
  dev: bigint;
  ino: bigint;
};

export type ReadCodexTranscriptOptions = {
  path: string;
  expectedSessionId: string;
  expectedCwd: string;
  format: string;
  expectedFileIdentity: ExpectedFileIdentity;
  maxBytes?: number;
  maxEvents?: number;
};

export type ResolveSessionTranscriptInput = {
  harness: "codex";
  sessionId: string;
  projectId: string;
  cwd: string;
  path?: string | null;
  format: string;
  allowedRoots: readonly string[];
};

export type ResolveSessionTranscriptResult =
  | TranscriptReadResult
  | { status: "scope_violation"; reason: string };
