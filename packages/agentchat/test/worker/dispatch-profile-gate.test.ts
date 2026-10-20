import { describe, expect, test } from "bun:test";

import {
  assertProfileDispatchSeat,
  ProfileEnforcementError,
} from "@src/worker/dispatch-profile-gate.js";

describe("assertProfileDispatchSeat", () => {
  test("passes when no profile is set", () => {
    expect(() => {
      assertProfileDispatchSeat({
        agentName: "claude-acp",
        permissionProfile: null,
        seat: { adapter: "stdio-acp" },
      });
    }).not.toThrow();
    expect(() => {
      assertProfileDispatchSeat({ agentName: "claude-acp", permissionProfile: undefined });
    }).not.toThrow();
  });

  test("passes for natively enforcing adapters", () => {
    expect(() => {
      assertProfileDispatchSeat({
        agentName: "http-seat",
        permissionProfile: "review_readonly",
        seat: { adapter: "openai-compat-http" },
      });
    }).not.toThrow();
  });

  test("passes for seats opting in via enforces_permission_profiles", () => {
    expect(() => {
      assertProfileDispatchSeat({
        agentName: "claude-acp",
        permissionProfile: "review_readonly",
        seat: { adapter: "stdio-acp", enforces_permission_profiles: ["review_readonly"] },
      });
    }).not.toThrow();
  });

  test("fails closed for a missing seat", () => {
    expect(() => {
      assertProfileDispatchSeat({
        agentName: "ghost",
        permissionProfile: "review_readonly",
        seat: undefined,
      });
    }).toThrow(ProfileEnforcementError);
  });

  test("fails closed for a seat that cannot enforce", () => {
    let caught: unknown;
    try {
      assertProfileDispatchSeat({
        agentName: "claude-acp",
        permissionProfile: "review_readonly",
        seat: { adapter: "stdio-acp" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProfileEnforcementError);
    expect((caught as ProfileEnforcementError).agentName).toBe("claude-acp");
    expect((caught as ProfileEnforcementError).message).toContain("review_readonly");
  });
});
