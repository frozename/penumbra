import { expect, test } from "bun:test";
import { approveHandoffHandler } from "../../src/tools/handoff-approve.js";

test("approveHandoffHandler approves and returns status", async () => {
  let received: any = null;
  const fakeClient = {
    approveHandoff: async (id: string, body: any) => {
      received = { id, body };
      return { handoff_id: id, status: "approved" };
    },
  };
  const handler = approveHandoffHandler(fakeClient as any);
  const result = await handler({ handoff_id: "h-1" });
  expect(received).toEqual({ id: "h-1", body: {} });
  expect(JSON.parse(result.content[0]!.text)).toEqual({ handoff_id: "h-1", status: "approved" });
});

test("approveHandoffHandler forwards redirect_to", async () => {
  let received: any = null;
  const fakeClient = {
    approveHandoff: async (id: string, body: any) => {
      received = body;
      return { handoff_id: id, status: "redirected" };
    },
  };
  const handler = approveHandoffHandler(fakeClient as any);
  await handler({ handoff_id: "h-1", redirect_to: "codex" });
  expect(received).toEqual({ redirect_to: "codex" });
});
