import { describe, expect, test } from "bun:test";

import {
  EnforcesPermissionProfilesSchema,
  PERMISSION_PROFILES,
  PermissionDecideResponseSchema,
  PermissionGetResponseSchema,
  PermissionProfileSchema,
  PermissionRememberSchema,
  PermissionRequestRowSchema,
  PermissionsListResponseSchema,
  PermissionStatusSchema,
} from "../src/index.js";

// Part of #342
// Catches: PERMISSION_PROFILES value, PermissionProfileSchema reject, EnforcesPermissionProfilesSchema accept/reject,
//          PermissionStatusSchema 'expired', PermissionRememberSchema reject, PermissionDecideResponseSchema required fields,
//          PermissionsListResponseSchema accept/reject/loose, PermissionGetResponseSchema reject/accept/loose,
//          PermissionRequestRowSchema decision_reason nullable-but-not-optional

function makeValidRow(): {
  permission_id: string;
  parent_handoff_id: string;
  conversation_id: string;
  agent_name: string;
  tool_name: string;
  raw_input_json: string;
  status: "pending";
  remember_scope: null;
  decision_reason: null;
  decided_by: null;
  ttl_at: string;
  created_at: string;
  decided_at: null;
} {
  return {
    permission_id: "p1",
    parent_handoff_id: "h1",
    conversation_id: "c1",
    agent_name: "a",
    tool_name: "t",
    raw_input_json: "{}",
    status: "pending",
    remember_scope: null,
    decision_reason: null,
    decided_by: null,
    ttl_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    decided_at: null,
  };
}

describe("PERMISSION_PROFILES", () => {
  test("toEqual ['review_readonly']", () => {
    expect(PERMISSION_PROFILES).toEqual(["review_readonly"]);
  });
});

describe("PermissionProfileSchema", () => {
  test("rejects 'write'", () => {
    expect(PermissionProfileSchema.safeParse("write").success).toBe(false);
  });
});

describe("EnforcesPermissionProfilesSchema", () => {
  test("accepts undefined, ['review_readonly'], and rejects ['nope']", () => {
    // The exported schema is .optional() which makes the exported type potentially
    // undefined at the TypeScript level, so we use .parse() directly.
    expect(() => EnforcesPermissionProfilesSchema.parse(undefined)).not.toThrow();
    expect(() => EnforcesPermissionProfilesSchema.parse([])).not.toThrow();
    expect(() => EnforcesPermissionProfilesSchema.parse(["review_readonly"])).not.toThrow();
    expect(() => EnforcesPermissionProfilesSchema.parse(["nope"])).toThrow();
  });
});

describe("PermissionStatusSchema", () => {
  test("accepts 'expired'", () => {
    expect(PermissionStatusSchema.safeParse("expired").success).toBe(true);
  });
});

describe("PermissionRememberSchema", () => {
  test("rejects 'forever'", () => {
    expect(PermissionRememberSchema.safeParse("forever").success).toBe(false);
  });
});

describe("PermissionDecideResponseSchema", () => {
  test("needs permission_id, status and decided_at: missing decided_at fails", () => {
    expect(
      PermissionDecideResponseSchema.safeParse({
        permission_id: "p1",
        status: "approved",
      }).success,
    ).toBe(false);
  });

  test("missing permission_id fails", () => {
    expect(
      PermissionDecideResponseSchema.safeParse({
        status: "approved",
        decided_at: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  test("missing status fails", () => {
    expect(
      PermissionDecideResponseSchema.safeParse({
        permission_id: "p1",
        decided_at: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  test("complete object succeeds", () => {
    expect(
      PermissionDecideResponseSchema.safeParse({
        permission_id: "p1",
        status: "approved",
        decided_at: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
  });

  test("status 'bogus' fails", () => {
    expect(
      PermissionDecideResponseSchema.safeParse({
        permission_id: "p1",
        status: "bogus",
        decided_at: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  test("extra key survives parse", () => {
    const result = PermissionDecideResponseSchema.safeParse({
      permission_id: "p1",
      status: "approved",
      decided_at: "2026-01-01T00:00:00Z",
      extra: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { extra?: unknown }).extra).toBe(true);
    }
  });
});

describe("PermissionsListResponseSchema", () => {
  test("accepts {permissions:[validRow]}", () => {
    expect(PermissionsListResponseSchema.safeParse({ permissions: [makeValidRow()] }).success).toBe(
      true,
    );
  });

  test("rejects {permissions:[{...validRow, status:'bogus'}]}", () => {
    expect(
      PermissionsListResponseSchema.safeParse({
        permissions: [{ ...makeValidRow(), status: "bogus" as const }],
      }).success,
    ).toBe(false);
  });

  test("keeps an extra top-level key", () => {
    const result = PermissionsListResponseSchema.safeParse({
      permissions: [makeValidRow()],
      extra: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { extra?: unknown }).extra).toBe(true);
    }
  });
});

describe("PermissionGetResponseSchema", () => {
  test("rejects {}", () => {
    expect(PermissionGetResponseSchema.safeParse({}).success).toBe(false);
  });

  test("accepts {permission: validRow}", () => {
    expect(PermissionGetResponseSchema.safeParse({ permission: makeValidRow() }).success).toBe(
      true,
    );
  });

  test("keeps an extra top-level key", () => {
    const result = PermissionGetResponseSchema.safeParse({
      permission: makeValidRow(),
      extra: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { extra?: unknown }).extra).toBe(true);
    }
  });
});

describe("PermissionRequestRowSchema", () => {
  test("rejects a row that omits decision_reason", () => {
    const rowWithoutDecisionReason: Partial<ReturnType<typeof makeValidRow>> = makeValidRow();
    delete rowWithoutDecisionReason.decision_reason;
    expect(PermissionRequestRowSchema.safeParse(rowWithoutDecisionReason).success).toBe(false);
    expect(PermissionRequestRowSchema.safeParse(makeValidRow()).success).toBe(true);
  });
});
