import { describe, it, expect } from "bun:test";
import { DaemonHttpError } from "../../src/daemon-client.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { permissionGetHandler } from "../../src/tools/permission-get.js";

function fakeDaemon(getPermission?: (permissionId: string) => Promise<unknown>): any {
  return {
    getPermission:
      getPermission ??
      (async (permissionId: string) => ({
        permission: {
          permission_id: permissionId,
          status: "pending",
          tool_name: "t",
          details: [{ field: "ok", value: "yes" }],
        },
      })),
  };
}

describe("permission_get - envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const handler = permissionGetHandler(fakeDaemon());
    const result: any = await handler({ permission_id: "p1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the current raw JSON shape when envelope is omitted", async () => {
    const permission = {
      permission_id: "p-raw",
      status: "pending",
      tool_name: "read_only",
      details: [{ field: "scope", value: "session" }],
    };
    const handler = permissionGetHandler(fakeDaemon(async () => ({ permission })));
    const result: any = await handler({ permission_id: "p-raw" });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(JSON.stringify({ permission }, null, 2));
  });

  it("keeps the non-envelope payload byte-identical when envelope=false", async () => {
    const permission = {
      permission_id: "p-raw-false",
      status: "pending",
      tool_name: "read_only",
      details: [{ field: "scope", value: "dispatch" }],
    };
    const handler = permissionGetHandler(fakeDaemon(async () => ({ permission })));
    const result: any = await handler({ permission_id: "p-raw-false", envelope: false });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].text).toBe(JSON.stringify({ permission }, null, 2));
  });

  it("truncates envelope text for over-budget payloads and reports full result_bytes", async () => {
    const permission = {
      permission_id: "p-big",
      status: "pending",
      tool_name: "huge_tool",
      details: Array.from({ length: 4000 }, (_, i) => ({
        idx: i,
        reason: "x".repeat(50),
      })),
    };
    const handler = permissionGetHandler(fakeDaemon(async () => ({ permission })));
    const result: any = await handler({ permission_id: "p-big", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    expect(result._meta.result_bytes).toBe(
      Buffer.byteLength(JSON.stringify({ permission }, null, 2), "utf8"),
    );
  });

  it("keeps not-found response as the existing non-envelope shape even when envelope=true", async () => {
    const err = new DaemonHttpError("daemon /permissions/missing: HTTP 404", 404, {
      error: { code: "not_found", message: "permission missing not found" },
    });
    const handler = permissionGetHandler(
      fakeDaemon(async () => {
        throw err;
      }),
    );

    const result: any = await handler({ permission_id: "missing", envelope: true });
    expect(isEnvelopeResult(result)).toBe(false);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: { code: "not_found", message: "permission missing not found" },
            },
            null,
            2,
          ),
        },
      ],
    });
  });
});
