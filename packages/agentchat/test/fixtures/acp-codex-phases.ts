#!/usr/bin/env bun
import { createInterface } from "node:readline";

/**
 * Fake codex-acp-style ACP agent for the phase-separation round-trip tests.
 *
 * codex-acp 1.4.0 stamps every agent_message_chunk with
 *   _meta: { codex: { phase: "commentary" | "final_answer" } }
 * via createCodexMessagePhaseMeta(phase). Passing `null` emits
 * `_meta.codex.phase: null`; passing no phase argument emits no _meta field at
 * all — the adapter normalises null/empty/absent to phase-less. Penumbra's
 * recorded dispatch response must be the final_answer chunks only —
 * commentary is progress narration.
 *
 * ACP_PHASE_MODE (env) selects the scenario streamed on session/prompt:
 *   phased      — commentary chunk, a tool_call update, then a final_answer
 *                 chunk (the production leak shape: "…commentary…NO_BUGS")
 *   mixed       — commentary, a `phase: null` chunk, a no-_meta chunk, then
 *                 final_answer: phase-less chunks must NOT land in the response
 *                 when a real final_answer exists
 *   no_final    — commentary + null-phase chunks and no final_answer: the adapter
 *                 must fail open on the full concatenation and warn
 *   unphased    — no _meta on any chunk (non-codex agents): unchanged behaviour
 *   warmup      — first prompt gets its own commentary+final_answer, second
 *                 prompt gets distinct commentary+final_answer: pins the
 *                 modelWarmupPrompt reset so warmup text cannot leak
 *   warmup_drift— first prompt streams commentary+final_answer, second prompt
 *                 streams commentary only: pins that turn-1 final_answer does
 *                 not leak into the turn-2 response (drift fallback fires)
 *   trailing    — final_answer chunk followed by trailing commentary: the
 *                 post-answer commentary must NOT land in the response
 *   empty_final — commentary + an EMPTY final_answer chunk: response falls
 *                 back to the full concatenation rather than returning ""
 *   silent      — no chunks at all: response is "" (unchanged behaviour)
 *   whitespace_final — commentary + a whitespace-only final_answer: response
 *                 falls back to the full concatenation
 *   error_phased— commentary chunk, then session/prompt fails: the error path
 *                 still resolves final text without reporting response drift
 */

interface JsonRpcRequest {
  method?: unknown;
  id?: unknown;
  params?: { sessionId?: unknown } | undefined;
}

const mode = process.env.ACP_PHASE_MODE ?? "phased";
const rl = createInterface({ input: process.stdin, terminal: false });
let promptCount = 0;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function messageChunk(sessionId: unknown, text: string, phase?: string | null): void {
  const update: Record<string, unknown> = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  };
  if (phase !== undefined) {
    update._meta = { codex: { phase } };
  }
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function toolCall(sessionId: unknown): void {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "shell",
        kind: "execute",
        status: "in_progress",
        input: { command: "ls callers" },
      },
    },
  });
}

function streamTurn(sessionId: unknown): void {
  switch (mode) {
    case "phased":
      messageChunk(sessionId, "I'll check the callers first.", "commentary");
      toolCall(sessionId);
      messageChunk(sessionId, "NO_BUGS", "final_answer");
      return;
    case "mixed":
      messageChunk(sessionId, "progress note.", "commentary");
      messageChunk(sessionId, "NULL_PHASE_ITEM", null);
      messageChunk(sessionId, "NO_META_ITEM");
      messageChunk(sessionId, "THE_ANSWER", "final_answer");
      return;
    case "no_final":
      messageChunk(sessionId, "work log.", "commentary");
      messageChunk(sessionId, "orphan text", null);
      return;
    case "unphased":
      messageChunk(sessionId, "foo");
      messageChunk(sessionId, "bar");
      return;
    case "warmup":
      if (promptCount === 1) {
        messageChunk(sessionId, "warmup narration.", "commentary");
        messageChunk(sessionId, "WARMUP_RESULT", "final_answer");
      } else {
        messageChunk(sessionId, "task narration.", "commentary");
        messageChunk(sessionId, "TASK_RESULT", "final_answer");
      }
      return;
    case "warmup_drift":
      if (promptCount === 1) {
        messageChunk(sessionId, "warmup narration.", "commentary");
        messageChunk(sessionId, "STALE_WARMUP_ANSWER", "final_answer");
      } else {
        messageChunk(sessionId, "task narration.", "commentary");
      }
      return;
    case "trailing":
      messageChunk(sessionId, "FOUND_ANSWER", "final_answer");
      messageChunk(sessionId, "post-answer narration.", "commentary");
      return;
    case "empty_final":
      messageChunk(sessionId, "progress note.", "commentary");
      messageChunk(sessionId, "", "final_answer");
      return;
    case "whitespace_final":
      messageChunk(sessionId, "progress note.", "commentary");
      messageChunk(sessionId, "  \n", "final_answer");
      return;
    case "silent":
      return;
    case "error_phased":
      messageChunk(sessionId, "work log.", "commentary");
      return;
    default:
      messageChunk(sessionId, `unknown ACP_PHASE_MODE=${mode}`);
  }
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line) as JsonRpcRequest;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, authMethods: [] } });
    return;
  }
  if (request.method === "session/new") {
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "phases-session" } });
    return;
  }
  if (request.method === "session/prompt") {
    promptCount += 1;
    streamTurn(request.params?.sessionId);
    if (mode === "error_phased") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "prompt exploded" },
      });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
