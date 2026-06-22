import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { DaemonClient } from "../../src/daemon-client.js";

import { dispatchLandHandler, DispatchLandInputShape } from "../../src/tools/dispatch-land.js";
import { TOOL_REGISTRY } from "../../src/tools/registry.js";
import { fakeDaemon } from "../helpers.js";

type DispatchLandFn = DaemonClient["dispatchLand"];
type DispatchLandReq = Parameters<DispatchLandFn>[0];

describe("dispatch.land tool", () => {
  test("DispatchLandInputShape requires handoff_id + commit_message", () => {
    const schema = z.object(DispatchLandInputShape);
    expect(() => schema.parse({ handoff_id: "h-1", commit_message: "feat: msg" })).not.toThrow();
    expect(() => schema.parse({ handoff_id: "h-1" })).toThrow();
    expect(() => schema.parse({ commit_message: "feat: msg" })).toThrow();
  });

  test("dispatchLandHandler delegates to daemon and returns JSON text", async () => {
    const calls: DispatchLandReq[] = [];
    const dispatchLand: DispatchLandFn = (input) => {
      calls.push(input);
      return Promise.resolve({
        ok: true,
        commit_sha: "abc123",
        message_subject: "feat: msg",
        branch_deleted: true,
        pr_closed: false,
      });
    };
    const handler = dispatchLandHandler(fakeDaemon({ dispatchLand }));

    const res = await handler({
      handoff_id: "h-1",
      commit_message: "feat: msg",
      mode: "squash",
      delete_branch: true,
      force: false,
    });

    expect(calls).toEqual([
      {
        handoff_id: "h-1",
        commit_message: "feat: msg",
        mode: "squash",
        delete_branch: true,
        force: false,
      },
    ]);
    expect(Array.isArray(res.content)).toBe(true);
    const block = res.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(block.type).toBe("text");
    expect(block.text).toContain('"ok": true');
    expect(block.text).toContain('"commit_sha": "abc123"');
  });

  test("registry exposes dispatch.land as mutating", () => {
    expect(TOOL_REGISTRY["dispatch_land"]).toBeDefined();
    expect(TOOL_REGISTRY["dispatch_land"]?.readOnly).toBe(false);
  });
});
