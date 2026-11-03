import { describe, expect, mock, test } from "bun:test";

import {
  capAskPatterns,
  type PermissionReplyClient,
  readAskPatterns,
  readPermissionAsk,
  sendAskReply,
  throwOnRejectedAskIdleEmpty,
} from "@src/adapters/opencode-permission.js";

function makeClient(): {
  client: PermissionReplyClient;
  replyPermission: ReturnType<typeof mock>;
  respondPermission: ReturnType<typeof mock>;
  replySessionPermission: ReturnType<typeof mock>;
} {
  const replyPermission = mock(() => Promise.resolve());
  const respondPermission = mock(() => Promise.resolve());
  const replySessionPermission = mock(() => Promise.resolve());
  return {
    client: { replyPermission, respondPermission, replySessionPermission },
    replyPermission,
    respondPermission,
    replySessionPermission,
  };
}

const ask = { requestID: "per_1", sessionID: "s1", permission: "bash", patterns: [] };

describe("readAskPatterns", () => {
  test("v1 reads props.patterns", () => {
    expect(readAskPatterns("permission.asked", { patterns: ["ls", "cat"] })).toEqual(["ls", "cat"]);
  });

  test("v2 reads props.resources and ignores patterns", () => {
    expect(
      readAskPatterns("permission.v2.asked", { resources: ["file:a"], patterns: ["ignored"] }),
    ).toEqual(["file:a"]);
  });

  test("returns [] for undefined props and non-array values", () => {
    expect(readAskPatterns("permission.asked", undefined)).toEqual([]);
    expect(readAskPatterns("permission.asked", { patterns: "nope" })).toEqual([]);
    expect(readAskPatterns("permission.asked", { patterns: null })).toEqual([]);
    expect(readAskPatterns("permission.v2.asked", { resources: "nope" })).toEqual([]);
    expect(readAskPatterns("permission.v2.asked", { resources: null })).toEqual([]);
  });

  test("filters out non-string entries", () => {
    expect(readAskPatterns("permission.asked", { patterns: ["a", 1, null, "b"] })).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("readPermissionAsk", () => {
  test("v1 ask normalizes to PermissionAsk", () => {
    expect(
      readPermissionAsk(
        "permission.asked",
        { id: "per_1", sessionID: "s1", permission: "bash", patterns: ["ls"] },
        "fallback",
      ),
    ).toEqual({ requestID: "per_1", sessionID: "s1", permission: "bash", patterns: ["ls"] });
  });

  test("v2 ask uses action as permission and resources as patterns", () => {
    expect(
      readPermissionAsk(
        "permission.v2.asked",
        { id: "per_2", sessionID: "s2", action: "edit", resources: ["file:a"] },
        "fallback",
      ),
    ).toEqual({ requestID: "per_2", sessionID: "s2", permission: "edit", patterns: ["file:a"] });
  });

  test("v2 ask with only permission (no action) is null", () => {
    expect(
      readPermissionAsk("permission.v2.asked", { id: "per_1", permission: "bash" }, "fallback"),
    ).toBeNull();
  });

  test("v1 ask with only action is null", () => {
    expect(
      readPermissionAsk("permission.asked", { id: "per_1", action: "bash" }, "fallback"),
    ).toBeNull();
  });

  test("returns null for missing props, id, or kind", () => {
    expect(readPermissionAsk("permission.asked", undefined, "fallback")).toBeNull();
    expect(
      readPermissionAsk("permission.asked", { sessionID: "s1", permission: "bash" }, "f"),
    ).toBeNull();
    expect(readPermissionAsk("permission.asked", { id: "", permission: "bash" }, "f")).toBeNull();
    expect(readPermissionAsk("permission.asked", { id: 7, permission: "bash" }, "f")).toBeNull();
    expect(readPermissionAsk("permission.asked", { id: "per_1" }, "f")).toBeNull();
    expect(readPermissionAsk("permission.asked", { id: "per_1", permission: "" }, "f")).toBeNull();
  });

  test("sessionID falls back when missing, empty, or non-string", () => {
    expect(
      readPermissionAsk("permission.asked", { id: "per_1", permission: "bash" }, "fb"),
    ).toEqual({ requestID: "per_1", sessionID: "fb", permission: "bash", patterns: [] });
    expect(
      readPermissionAsk(
        "permission.asked",
        { id: "per_1", sessionID: "", permission: "bash" },
        "fb",
      ),
    ).toEqual({ requestID: "per_1", sessionID: "fb", permission: "bash", patterns: [] });
    expect(
      readPermissionAsk(
        "permission.asked",
        { id: "per_1", sessionID: 42, permission: "bash" },
        "fb",
      ),
    ).toEqual({ requestID: "per_1", sessionID: "fb", permission: "bash", patterns: [] });
  });
});

describe("capAskPatterns", () => {
  test("empty list", () => {
    expect(capAskPatterns([])).toEqual({ list: [], truncated: false });
  });

  test("512-char entry kept verbatim; 513-char entry cut with ellipsis", () => {
    const exact = "a".repeat(512);
    expect(capAskPatterns([exact])).toEqual({ list: [exact], truncated: false });

    const over = "b".repeat(513);
    const result = capAskPatterns([over]);
    expect(result.truncated).toBe(true);
    expect(result.list).toHaveLength(1);
    expect(result.list[0]).toBe(`${"b".repeat(512)}…`);
    expect(result.list[0]?.length).toBe(513);
    expect(result.list[0]?.endsWith("…")).toBe(true);
  });

  test("exact budget boundary: check is >, not >=", () => {
    // Budget 2048, base size 2 ("[]"). Four 500-char strings are each 502
    // JSON bytes (quotes); the 2nd-4th add 1 for the comma:
    //   2 + 502 + 503 + 503 + 503 = 2013
    // A 32-char string adds 34 + 1 comma = 35, landing exactly on 2048,
    // which the `>` check keeps.
    const four = ["a".repeat(500), "b".repeat(500), "c".repeat(500), "d".repeat(500)];
    const atBoundary = [...four, "e".repeat(32)];
    expect(capAskPatterns(atBoundary)).toEqual({ list: atBoundary, truncated: false });

    // One more char tips it to 2049 and drops the last entry.
    const overBoundary = [...four, `${"e".repeat(32)}a`];
    const result = capAskPatterns(overBoundary);
    expect(result.list).toEqual(four);
    expect(result.truncated).toBe(true);
  });

  test("overflow breaks the loop, not continues it", () => {
    // Four 500-char strings occupy 2 + 502 + 503*3 = 2013 bytes. The 600-char
    // entry is cut to 513 chars = 515 JSON bytes + 1 comma = 516, and
    // 2013 + 516 = 2529 > 2048, so the loop breaks there and the trailing
    // "x" — which alone would have fit — is never considered.
    const four = ["a".repeat(500), "b".repeat(500), "c".repeat(500), "d".repeat(500)];
    const result = capAskPatterns([...four, "f".repeat(600), "x"]);
    expect(result.list).toEqual(four);
    expect(result.list).not.toContain("x");
    expect(result.truncated).toBe(true);
  });
});

describe("sendAskReply", () => {
  test("v2 approved calls replySessionPermission only, no message", async () => {
    const { client, replyPermission, respondPermission, replySessionPermission } = makeClient();
    const result = await sendAskReply({
      client,
      wireType: "permission.v2.asked",
      ask,
      reply: "once",
      approved: true,
    });
    expect(replySessionPermission).toHaveBeenCalledTimes(1);
    expect(replySessionPermission).toHaveBeenCalledWith("s1", "per_1", { reply: "once" });
    expect(result).toEqual({ route: "v2" });
    expect(replyPermission).not.toHaveBeenCalled();
    expect(respondPermission).not.toHaveBeenCalled();
  });

  test("v2 rejected carries the auto-reject message", async () => {
    const { client, replySessionPermission } = makeClient();
    await sendAskReply({
      client,
      wireType: "permission.v2.asked",
      ask,
      reply: "reject",
      approved: false,
    });
    expect(replySessionPermission).toHaveBeenCalledWith("s1", "per_1", {
      reply: "reject",
      message: "penumbra: permission 'bash' auto-rejected",
    });
  });

  test("v2 failure does not fall back to v1 routes", async () => {
    const { client, replyPermission, respondPermission, replySessionPermission } = makeClient();
    const errV2 = new Error("v2 boom");
    replySessionPermission.mockRejectedValueOnce(errV2);
    const result = await sendAskReply({
      client,
      wireType: "permission.v2.asked",
      ask,
      reply: "once",
      approved: true,
    });
    expect(result).toEqual({ route: "v2", error: errV2 });
    expect(result.error).toBe(errV2);
    expect(replyPermission).not.toHaveBeenCalled();
    expect(respondPermission).not.toHaveBeenCalled();
  });

  test("v1 approved succeeds on the reply route", async () => {
    const { client, replyPermission, respondPermission, replySessionPermission } = makeClient();
    const result = await sendAskReply({
      client,
      wireType: "permission.asked",
      ask,
      reply: "always",
      approved: true,
    });
    expect(replyPermission).toHaveBeenCalledWith("per_1", { reply: "always" });
    expect(result).toEqual({ route: "reply" });
    expect(respondPermission).not.toHaveBeenCalled();
    expect(replySessionPermission).not.toHaveBeenCalled();
  });

  test("v1 reply failure falls back to respond route without message", async () => {
    const { client, replyPermission, respondPermission } = makeClient();
    replyPermission.mockRejectedValueOnce(new Error("reply boom"));
    const result = await sendAskReply({
      client,
      wireType: "permission.asked",
      ask,
      reply: "reject",
      approved: false,
    });
    expect(respondPermission).toHaveBeenCalledWith("s1", "per_1", { response: "reject" });
    expect(result).toEqual({ route: "respond" });
    expect("error" in result).toBe(false);
  });

  test("v1 both routes fail: error is the respond error", async () => {
    const { client, replyPermission, respondPermission } = makeClient();
    const errA = new Error("reply boom");
    const errB = new Error("respond boom");
    replyPermission.mockRejectedValueOnce(errA);
    respondPermission.mockRejectedValueOnce(errB);
    const result = await sendAskReply({
      client,
      wireType: "permission.asked",
      ask,
      reply: "reject",
      approved: false,
    });
    expect(result.route).toBe("respond");
    expect(result.error).toBe(errB);
  });

  test("unknown wireType takes the v1 path", async () => {
    const { client, replyPermission, replySessionPermission } = makeClient();
    const result = await sendAskReply({
      client,
      wireType: "permission.other",
      ask,
      reply: "once",
      approved: true,
    });
    expect(replyPermission).toHaveBeenCalledTimes(1);
    expect(replySessionPermission).not.toHaveBeenCalled();
    expect(result).toEqual({ route: "reply" });
  });
});

describe("throwOnRejectedAskIdleEmpty", () => {
  test("does not throw for empty rejected list or non-blank text", () => {
    expect(() => {
      throwOnRejectedAskIdleEmpty([], "");
    }).not.toThrow();
    expect(() => {
      throwOnRejectedAskIdleEmpty([{ permission: "bash", replyFailed: false }], "done");
    }).not.toThrow();
  });

  test("throws for whitespace-only text with rejected asks", () => {
    expect(() => {
      throwOnRejectedAskIdleEmpty([{ permission: "bash", replyFailed: false }], "  \n\t");
    }).toThrow();
  });

  test("exact message lists kinds and reply_failed count", () => {
    expect(() => {
      throwOnRejectedAskIdleEmpty(
        [
          { permission: "doom_loop", replyFailed: true },
          { permission: "edit", replyFailed: false },
        ],
        "",
      );
    }).toThrow(
      "opencode-acp: turn ended idle with empty text after 2 rejected permission ask(s) [doom_loop,edit] (1 reply_failed); opencode halts the turn on a plain permission reject",
    );
  });
});
