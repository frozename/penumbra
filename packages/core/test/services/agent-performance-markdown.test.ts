import {
  parseAgentPerformanceMarkdownRows,
  renderAgentPerformanceMarkdown,
} from "@src/services/agent-performance-markdown.js";
import { describe, expect, test } from "bun:test";

type ParsedMetadata = {
  legacy_marker?: string;
  smoke_marker?: string;
  cost_marker?: string;
  latency_marker?: string;
  task_type_original?: string;
};

const parseMetadata = (json: string): ParsedMetadata => JSON.parse(json) as ParsedMetadata;

describe("parseAgentPerformanceMarkdownRows", () => {
  test("parses legacy ledger rows into normalized seed rows", () => {
    const markdown = `
| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-04-28 | codex-mini | implement_substantial | merged* | 1 | y | 5 | 0 | ~0.40 | 8 | Clean first-shot; cherry-picked to main. |
| 2026-04-28 | gemini | implement_substantial | merged_with_concerns | 1 | n* | 5 | 0 | ~0.60 | 13 | Smoke failed but caught a real architecture bug. |
`;
    const rows = parseAgentPerformanceMarkdownRows({
      markdown,
      sourcePath: "docs/superpowers/notes/agent-performance.md",
      projectId: "penumbra",
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]!.agent_name).toBe("codex-mini");
    expect(rows[0]!.outcome).toBe("merged");
    expect(rows[0]!.smoke_pass).toBe("y");
    expect(rows[0]!.cost_usd).toBe(0.4);
    expect(rows[0]!.latency_ms).toBe(8 * 60_000);
    expect(rows[0]!.source).toBe("manual_seed");
    expect(parseMetadata(rows[0]!.metadata_json).legacy_marker).toBe("*");
    expect(rows[1]!.outcome).toBe("merged_with_concerns");
    expect(rows[1]!.smoke_pass).toBe("n");
    expect(parseMetadata(rows[1]!.metadata_json).smoke_marker).toBe("*");
  });

  test("parseAgentPerformanceMarkdownRows skips non-matching tables", () => {
    const markdown = `
| foo | bar |
| --- | --- |
| a | b |

| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-04-28 | codex-mini | implement_substantial | merged | 1 | y | 5 | 0 | 0.40 | 8 | Valid row. |
`;

    const rows = parseAgentPerformanceMarkdownRows({
      markdown,
      sourcePath: "docs/superpowers/notes/agent-performance.md",
      projectId: "penumbra",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_name).toBe("codex-mini");
  });

  test("parseAgentPerformanceMarkdownRows handles n/a, ~, <1 markers", () => {
    const markdown = `
| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-04-29 | gemini | review_adversarial | bypassed* |  | n/a* |  |  | <1 | <1 | Marker row. |
| 2026-04-30 | codex-mini | docs_mechanical | no_changes | 0 | n/a | 4 | 0 | ~1.25 | n/a | Cost marker row. |
`;

    const rows = parseAgentPerformanceMarkdownRows({
      markdown,
      sourcePath: "docs/superpowers/notes/agent-performance.md",
      projectId: "penumbra",
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]!.cost_usd).toBeNull();
    expect(rows[0]!.latency_ms).toBeNull();
    expect(rows[0]!.smoke_pass).toBe("n/a");
    expect(JSON.parse(rows[0]!.metadata_json)).toMatchObject({
      legacy_marker: "*",
      smoke_marker: "*",
      cost_marker: "<1",
      latency_marker: "<1",
    });
    expect(rows[1]!.cost_usd).toBe(1.25);
    expect(rows[1]!.latency_ms).toBeNull();
    expect(JSON.parse(rows[1]!.metadata_json)).toMatchObject({
      cost_marker: "~",
    });
  });

  test("parseAgentPerformanceMarkdownRows coerces legacy task types to unknown and preserves the original value in metadata", () => {
    const markdown = `
| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-04-30 | codex-mini | publish_and_smoke | merged | 1 | y | 5 | 0 | 0.40 | 8 | Legacy task type. |
| 2026-04-30 | gemini | implement_small | merged | 1 | n | 4 | 0 | 0.50 | 9 | Canonical task type. |
`;

    const rows = parseAgentPerformanceMarkdownRows({
      markdown,
      sourcePath: "docs/superpowers/notes/agent-performance.md",
      projectId: "penumbra",
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]!.task_type).toBe("unknown");
    expect(parseMetadata(rows[0]!.metadata_json).task_type_original).toBe("publish_and_smoke");
    expect(rows[1]!.task_type).toBe("implement_small");
    expect(parseMetadata(rows[1]!.metadata_json).task_type_original).toBeUndefined();
  });
});

describe("renderAgentPerformanceMarkdown", () => {
  test('renderAgentPerformanceMarkdown emits canonical header and the "Generated from agent_performance" preamble', () => {
    const markdown = renderAgentPerformanceMarkdown(
      [
        {
          performance_id: "p1",
          ts: "2026-04-28T12:00:00.000Z",
          handoff_id: "h1",
          conversation_id: "c1",
          project_id: "penumbra",
          agent_name: "codex-mini",
          task_type: "implement_substantial",
          outcome: "merged",
          rounds: 1,
          smoke_pass: "y",
          reviewer_findings: 0,
          maestro_score: 5,
          cost_usd: 0.4,
          tokens_used: null,
          latency_ms: 8 * 60_000,
          source: "operator",
          notes: "Clean first-shot implementation.",
          metadata_json: "{}",
        },
      ],
      {
        generatedAt: "2026-05-01T12:00:00.000Z",
      },
    );

    expect(
      markdown.startsWith(
        "# Agent performance ledger\n\nGenerated from agent_performance at 2026-05-01T12:00:00.000Z.\n\n",
      ),
    ).toBe(true);
    expect(markdown).toContain(
      "| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |",
    );
  });

  test("renderAgentPerformanceMarkdown round-trips: parse → render → parse preserves outcome/agent/task_type/cost/latency", () => {
    const markdown = `
| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-04-28 | codex-mini | implement_substantial | merged* | 1 | y | 5 | 0 | ~0.40 | 8 | Clean first-shot implementation. |
| 2026-04-29 | gemini | review_adversarial | bypassed | 0 | n/a | 4 | 1 | n/a | <1 | Review only. |
`;
    const parsed = parseAgentPerformanceMarkdownRows({
      markdown,
      sourcePath: "docs/superpowers/notes/agent-performance.md",
      projectId: "penumbra",
    });

    const rendered = renderAgentPerformanceMarkdown(parsed, {
      generatedAt: "2026-05-01T12:00:00.000Z",
    });
    const reparsed = parseAgentPerformanceMarkdownRows({
      markdown: rendered,
      sourcePath: "docs/superpowers/notes/agent-performance.generated.md",
      projectId: "penumbra",
    });

    expect(reparsed).toHaveLength(2);
    expect(
      reparsed.map((row) => ({
        agent_name: row.agent_name,
        task_type: row.task_type,
        outcome: row.outcome,
        cost_usd: row.cost_usd,
        latency_ms: row.latency_ms,
      })),
    ).toEqual(
      parsed.map((row) => ({
        agent_name: row.agent_name,
        task_type: row.task_type,
        outcome: row.outcome,
        cost_usd: row.cost_usd,
        latency_ms: row.latency_ms,
      })),
    );
  });
});
