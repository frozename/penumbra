import { describe, expect, it } from "bun:test";

import {
  type StampInputAgent,
  type StampInputTick,
  stampPrompt,
} from "../../src/long-lived/prompt-stamper.js";

const baseTick: StampInputTick = {
  id: "t1",
  trigger_kind: "cron",
  trigger_payload: null,
  now_iso: "2026-05-18T00:00:00Z",
};
const baseAgent: StampInputAgent = {
  id: "home-mgmt",
  display_name: "Home Mgmt",
  standing_brief: "test",
  working_memory: {
    version: 1,
    updated_at: 0,
    pending_goals: [],
    open_threads: [],
    watches: [],
    recent_decisions: [],
  },
  mcp_allowlist: ["ha:ha_pulse"],
  bounds: { wall_clock_ms: 360000, cost_cents: 50, max_sub_dispatches: 3 },
};

describe("stampPrompt", () => {
  it("includes display_name and standing brief", () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).toContain("Home Mgmt");
    expect(out).toContain("test");
  });

  it("includes pretty-printed working memory and pending goals", () => {
    const agent: StampInputAgent = {
      ...baseAgent,
      working_memory: {
        version: 1,
        updated_at: 0,
        pending_goals: [{ kind: "user_goal", text: "check the dryer" }],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      },
    };
    const out = stampPrompt({ agent, tick: baseTick });
    expect(out).toContain("check the dryer");
  });

  it("renders allowlist entries in SDK canonical form", () => {
    const out = stampPrompt({
      agent: {
        ...baseAgent,
        mcp_allowlist: ["ha:state.list", "penumbra:long_lived_self_state_set"],
      },
      tick: baseTick,
    });
    expect(out).toContain("mcp__ha__state.list");
    expect(out).toContain("mcp__penumbra__long_lived_self_state_set");
    expect(out).not.toContain("mcp__ha__integration.install");
  });

  it("includes dispatch-envelope instructions when chain_start is allowlisted", () => {
    const out = stampPrompt({
      agent: {
        ...baseAgent,
        mcp_allowlist: ["penumbra:chain_start", "penumbra:long_lived_self_state_set"],
      },
      tick: { ...baseTick, id: "tick-99" },
    });
    expect(out).toContain("Dispatching sub-chains from this tick:");
    expect(out).toContain('dispatch_kind: "long_lived_tick"');
    expect(out).toContain('long_lived_tick_id: "tick-99"');
    expect(out).toContain('long_lived_agent_id: "home-mgmt"');
  });

  it("dispatch-envelope section warns against reusing stale tick IDs from working memory", () => {
    const out = stampPrompt({
      agent: {
        ...baseAgent,
        mcp_allowlist: ["penumbra:chain_start"],
      },
      tick: { ...baseTick, id: "tick-abc" },
    });
    expect(out).toContain("tick IDs are single-use");
    expect(out).toContain("Do NOT copy a tick ID from your working memory notes");
    expect(out).toContain("tick-abc");
  });

  it("adds anti-confusion warning when both ha and non-ha tools are present", () => {
    const out = stampPrompt({
      agent: {
        ...baseAgent,
        mcp_allowlist: ["ha:ha_pulse", "penumbra:chain_start"],
      },
      tick: baseTick,
    });
    expect(out).toContain("NOT Home Assistant services");
    expect(out).toContain("mcp__ha__ha_call_service");
  });

  it("omits anti-confusion warning when only ha tools are present", () => {
    const out = stampPrompt({
      agent: {
        ...baseAgent,
        mcp_allowlist: ["ha:ha_pulse", "ha:ha_get_state"],
      },
      tick: baseTick,
    });
    expect(out).not.toContain("NOT Home Assistant services");
  });

  it("omits dispatch-envelope instructions when chain_start is not allowlisted", () => {
    const out = stampPrompt({
      agent: {
        ...baseAgent,
        mcp_allowlist: ["penumbra:long_lived_self_state_set"],
      },
      tick: { ...baseTick, id: "tick-99" },
    });
    expect(out).not.toContain("Dispatching sub-chains from this tick:");
    expect(out).not.toContain('long_lived_tick_id: "tick-99"');
  });

  it("mentions the required FIRST/LAST protocol with self_state_set", () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).toMatch(/FIRST action.*long_lived_self_state_set/s);
    expect(out).toMatch(/LAST action.*long_lived_self_state_set/s);
  });

  it("includes the tick budget", () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).toContain("360000ms");
    expect(out).toContain("50¢");
    expect(out).toContain("3 sub-dispatches");
  });

  it("reflects trigger_kind=event and inlines payload", () => {
    const out = stampPrompt({
      agent: baseAgent,
      tick: {
        id: "t2",
        trigger_kind: "event",
        trigger_payload: { server: "ha", event: "state_changed", entity_id: "light.kitchen" },
        now_iso: "now",
      },
    });
    expect(out).toContain("event");
    expect(out).toContain("light.kitchen");
  });

  it("does not render an unavailability section when no servers are unavailable", () => {
    const out = stampPrompt({ agent: { ...baseAgent, unavailable_servers: [] }, tick: baseTick });
    expect(out).not.toContain("unavailable this tick");
  });

  it("renders a warning for an unavailable server", () => {
    const out = stampPrompt({
      agent: { ...baseAgent, unavailable_servers: ["ha"] },
      tick: baseTick,
    });
    expect(out).toContain("MCP server 'ha' is unavailable this tick");
    expect(out).toContain("proceed without them");
  });

  it("lists multiple unavailable servers", () => {
    const out = stampPrompt({
      agent: { ...baseAgent, unavailable_servers: ["ha", "other"] },
      tick: baseTick,
    });
    expect(out).toContain("'ha'");
    expect(out).toContain("'other'");
  });

  it("treats omitted unavailable_servers like empty", () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).not.toContain("unavailable this tick");
  });

  it("shows mcp__ canonical invocation form for each allowlisted tool when allowlist spans multiple servers", () => {
    const out = stampPrompt({
      agent: {
        ...baseAgent,
        mcp_allowlist: ["ha:ha_pulse", "penumbra:chain_start", "penumbra:memory_search"],
      },
      tick: baseTick,
    });
    expect(out).toContain("mcp__ha__ha_pulse");
    expect(out).toContain("mcp__penumbra__chain_start");
    expect(out).toContain("mcp__penumbra__memory_search");
  });

  it("includes ha_call_service anti-pattern warning when ha and non-ha servers coexist", () => {
    const out = stampPrompt({
      agent: { ...baseAgent, mcp_allowlist: ["ha:ha_pulse", "penumbra:chain_start"] },
      tick: baseTick,
    });
    expect(out).toMatch(/do not.*ha_call_service|never.*ha_call_service/i);
  });

  it("omits anti-confusion preamble when allowlist has only one server", () => {
    const out = stampPrompt({
      agent: { ...baseAgent, mcp_allowlist: ["ha:ha_pulse", "ha:ha_get_state"] },
      tick: baseTick,
    });
    expect(out).not.toContain("NOT Home Assistant services");
    expect(out).not.toContain("ha_call_service");
  });

  it("dispatch-envelope section names the mcp__ canonical form, not bare tool name", () => {
    const out = stampPrompt({
      agent: { ...baseAgent, mcp_allowlist: ["ha:ha_pulse", "penumbra:chain_start"] },
      tick: { ...baseTick, id: "tick-99" },
    });
    expect(out).toContain("mcp__penumbra__chain_start");
  });

  it("includes binding tool invocation discipline for deferred-schema harnesses", () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).toContain("Tool invocation discipline (binding):");
    expect(out).toContain("ONE lookup");
    expect(out).toMatch(/NEVER try to reach MCP tools through Bash/);
  });

  it("directs the agent to report tool unavailability instead of working around it", () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).toMatch(/not callable after one load attempt.*long_lived_self_state_set/s);
    expect(out).toContain("reportable outcome");
  });

  it("declares an idle tick a success", () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).toContain("no pending work is a SUCCESS");
  });
});
