import { expect, test } from "bun:test";

import { chainSendMessageHandler } from "@src/tools/chain-send-message.js";

import { installFetchMock } from "../helpers.js";

test("chainSendMessageHandler returns ok on a successful inject", async () => {
  const { daemon, restore } = installFetchMock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  try {
    const out = await chainSendMessageHandler(daemon)({ handoff_id: "h-1", content: "hello" });
    expect(out).toEqual({
      content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }],
    });
  } finally {
    restore();
  }
});

test("chainSendMessageHandler surfaces not_found errors", async () => {
  const { daemon, restore } = installFetchMock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: "not_found", message: "missing" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  try {
    let caught: unknown;
    try {
      await chainSendMessageHandler(daemon)({ handoff_id: "h-missing", content: "hello" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "chain_send_message session not found: handoff h-missing not found",
    );
  } finally {
    restore();
  }
});

test("chainSendMessageHandler surfaces unsupported_adapter errors", async () => {
  const { daemon, restore } = installFetchMock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: "unsupported_adapter", message: "nope" } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  try {
    let caught: unknown;
    try {
      await chainSendMessageHandler(daemon)({ handoff_id: "h-1", content: "hello" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "chain_send_message adapter does not support mid-session inject",
    );
  } finally {
    restore();
  }
});
