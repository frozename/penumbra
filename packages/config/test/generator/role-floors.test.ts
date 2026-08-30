import { describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import { join } from "node:path";

import type { AgentConfig } from "@src/files/agents.js";
import type { ModelAliasMap } from "@src/files/model-aliases.js";
import { assertRoleFloors, CONSUMED_ROLE_TAGS } from "@src/generator/role-floors.js";

function agent(name: string, roles: string[]): AgentConfig {
  return {
    name,
    adapter: "stdio-acp",
    options: {},
    roles,
    auto_approve_to: [],
    pricing_mode: "api",
  };
}

// One holder per role tag, dreaming-judge covered twice by distinct agents so
// callers can delete a single holder/alias entry to trigger exactly one violation.
function completeAgents(): AgentConfig[] {
  return [
    agent("rewriter-seat", ["dreaming-rewriter"]),
    agent("brief-seat", ["brief-synthesizer"]),
    agent("judge-seat-a", ["dreaming-judge"]),
    agent("judge-seat-b", ["dreaming-judge"]),
    agent("memory-refiner-seat", ["memory-refiner"]),
    agent("refiner-seat", ["refiner"]),
  ];
}

function diverseAliasMap(): ModelAliasMap {
  return {
    "judge-seat-a": { aa_creator: "anthropic", aa_slug: "claude-sonnet-4-5" },
    "judge-seat-b": { aa_creator: "openai", aa_slug: "gpt-5.6" },
  };
}

describe("assertRoleFloors", () => {
  test("fails when any of the 5 consumed role tags has zero holders", () => {
    const agents = completeAgents().filter((a) => !a.roles.includes("refiner"));

    expect(() => {
      assertRoleFloors(agents, diverseAliasMap());
    }).toThrow(/refiner/);
  });

  test("fails when dreaming-judge has fewer than 2 holders", () => {
    const agents = completeAgents().filter((a) => a.name !== "judge-seat-b");

    expect(() => {
      assertRoleFloors(agents, diverseAliasMap());
    }).toThrow(/dreaming-judge/);
  });

  test("fails when dreaming-judge's 2 holders resolve to the same (aa_creator, aa_slug) pair", () => {
    const aliasMap: ModelAliasMap = {
      "judge-seat-a": { aa_creator: "anthropic", aa_slug: "claude-sonnet-4-5" },
      "judge-seat-b": { aa_creator: "anthropic", aa_slug: "claude-sonnet-4-5" },
    };

    expect(() => {
      assertRoleFloors(completeAgents(), aliasMap);
    }).toThrow(/dreaming-judge/);
  });

  test("does not throw when every floor is satisfied with lineage-diverse dreaming-judge holders", () => {
    expect(() => {
      assertRoleFloors(completeAgents(), diverseAliasMap());
    }).not.toThrow();
  });

  test("the CONSUMED_ROLE_TAGS list matches the role-tag defaults literally present in source", () => {
    // The 2026-08-19 role-floor incident: retiring one seat silently zeroed two
    // live subsystems because nothing pinned the role tags actually read at
    // runtime. Each tag below is pinned against the file where daemon code
    // reads `process.env[...] ?? "<tag>"` — deps.ts only owns dreaming-rewriter
    // today; the other 4 defaults live in their own consuming files.
    const sources: Record<(typeof CONSUMED_ROLE_TAGS)[number], string> = {
      "dreaming-rewriter": "../../../daemon/src/dreaming/deps.ts",
      "brief-synthesizer": "../../../daemon/src/dreaming/brief-synthesizer.ts",
      "dreaming-judge": "../../../daemon/src/dreaming/dreaming-judge-pool.ts",
      "memory-refiner": "../../../daemon/src/workers/t2-promotion.ts",
      refiner: "../../../daemon/src/serve.ts",
    };

    for (const tag of CONSUMED_ROLE_TAGS) {
      const filePath = join(import.meta.dir, sources[tag]);
      const source = nodeFs.readFileSync(filePath, "utf8");
      expect(source).toContain(`?? "${tag}"`);
    }
  });
});
