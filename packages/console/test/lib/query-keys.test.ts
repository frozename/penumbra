import { describe, expect, test } from "bun:test";

import {
  handoffDetail,
  handoffsForConversation,
  latestHandoffForConversation,
} from "@src/lib/query-keys.js";

describe("handoff query keys", () => {
  test("latestHandoffForConversation returns a readonly tuple with the conversation id", () => {
    const key = latestHandoffForConversation("c1");
    expect(key).toEqual(["handoffs", "latest", "c1"]);
  });

  test("handoffsForConversation returns a readonly tuple scoped by status", () => {
    const key = handoffsForConversation("c1", "dispatched");
    expect(key).toEqual(["handoffs", "conversation", "c1", "dispatched"]);
  });

  test("new keys differ across conversations and statuses", () => {
    const latestA = latestHandoffForConversation("cA");
    const latestB = latestHandoffForConversation("cB");
    expect(latestA).not.toEqual(latestB);

    const dispatchedA = handoffsForConversation("cA", "dispatched");
    const pendingA = handoffsForConversation("cA", "pending");
    expect(dispatchedA).not.toEqual(pendingA);

    const dispatchedB = handoffsForConversation("cB", "dispatched");
    expect(dispatchedA).not.toEqual(dispatchedB);
  });

  test("legacy handoffDetail key is unchanged", () => {
    expect(handoffDetail("h1")).toEqual(["handoffs", "detail", "h1"]);
  });
});
