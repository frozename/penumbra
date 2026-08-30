import { expect, test } from "bun:test";

import {
  ConversationChainEndEventSchema,
  ConversationHopEndEventSchema,
  ConversationHopStartEventSchema,
  ConversationTokenEventSchema,
  HopStateCacheEntrySchema,
  MergeResultEventSchema,
  WorkerCancelEventSchema,
} from "@src/schemas/sse-events.js";

test("ConversationHopStartEventSchema validates the phase 2 hop-start payload", () => {
  expect(
    ConversationHopStartEventSchema.safeParse({
      type: "hop-start",
      handoff_id: "h-1",
      chain_id: "c-1",
      idx: 0,
      agent_name: "gemini-pro",
      status: "in_progress",
    }).success,
  ).toBe(true);
  expect(
    ConversationHopStartEventSchema.safeParse({
      type: "hop-start",
      handoff_id: "h-1",
      chain_id: "c-1",
      idx: -1,
      agent_name: "gemini-pro",
      status: "in_progress",
    }).success,
  ).toBe(false);
});

test("ConversationTokenEventSchema requires a non-negative seq and delta text", () => {
  expect(
    ConversationTokenEventSchema.safeParse({
      type: "token",
      handoff_id: "h-1",
      seq: 42,
      delta: " partial output",
    }).success,
  ).toBe(true);
  expect(
    ConversationTokenEventSchema.safeParse({
      type: "token",
      handoff_id: "h-1",
      seq: -1,
      delta: "partial output",
    }).success,
  ).toBe(false);
});

test("ConversationHopEndEventSchema allows optional full text while requiring chain correlation", () => {
  expect(
    ConversationHopEndEventSchema.safeParse({
      type: "hop-end",
      handoff_id: "h-1",
      chain_id: "c-1",
      next_handoff_id: null,
      error: null,
    }).success,
  ).toBe(true);
  expect(
    ConversationHopEndEventSchema.safeParse({
      type: "hop-end",
      handoff_id: "h-1",
      next_handoff_id: null,
      error: null,
    }).success,
  ).toBe(false);
});

test("ConversationChainEndEventSchema accepts all terminal reasons including cancelled", () => {
  expect(
    ConversationChainEndEventSchema.safeParse({
      type: "chain-end",
      chain_id: "c-1",
      reason: "cancelled",
    }).success,
  ).toBe(true);
  expect(
    ConversationChainEndEventSchema.safeParse({
      type: "chain-end",
      chain_id: "c-1",
      reason: "timeout",
    }).success,
  ).toBe(false);
});

test("WorkerCancelEventSchema requires both conversation and handoff correlation", () => {
  expect(
    WorkerCancelEventSchema.safeParse({
      type: "cancel",
      conversation_id: "conv-1",
      handoff_id: "h-1",
    }).success,
  ).toBe(true);
  expect(
    WorkerCancelEventSchema.safeParse({
      type: "cancel",
      conversation_id: "conv-1",
    }).success,
  ).toBe(false);
});

test("MergeResultEventSchema accepts no_changes reconciler outcomes", () => {
  expect(
    MergeResultEventSchema.safeParse({
      type: "merge-result",
      handoff_id: "h-empty",
      status: "no_changes",
    }).success,
  ).toBe(true);
});

test("HopStateCacheEntrySchema enforces matching handoff ids and increasing token seq values", () => {
  expect(
    HopStateCacheEntrySchema.safeParse({
      conversation_id: "conv-1",
      hop_start: {
        type: "hop-start",
        handoff_id: "h-1",
        chain_id: "c-1",
        idx: 0,
        agent_name: "gemini-pro",
        status: "in_progress",
      },
      tokens: [
        { type: "token", handoff_id: "h-1", seq: 1, delta: "hello" },
        { type: "token", handoff_id: "h-1", seq: 2, delta: " world" },
      ],
    }).success,
  ).toBe(true);

  expect(
    HopStateCacheEntrySchema.safeParse({
      conversation_id: "conv-1",
      hop_start: {
        type: "hop-start",
        handoff_id: "h-1",
        chain_id: "c-1",
        idx: 0,
        agent_name: "gemini-pro",
        status: "in_progress",
      },
      tokens: [
        { type: "token", handoff_id: "h-1", seq: 2, delta: "hello" },
        { type: "token", handoff_id: "h-2", seq: 2, delta: " world" },
      ],
    }).success,
  ).toBe(false);
});
