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
  | {
      status: "unsupported" | "identity_mismatch" | "unavailable";
      reason: string;
    };

export type ReadCodexTranscriptOptions = {
  path: string;
  expectedSessionId: string;
  expectedCwd: string;
  format: string;
  maxBytes?: number;
  maxEvents?: number;
};
