import { expect, test } from "bun:test";

import { loadMarkdownPlaybook } from "../src/loaders/markdown.js";
import { renderTemplate } from "../src/template.js";

type TestScope = Record<string, unknown>;

function lookupHistorical(scope: TestScope, path: string): unknown {
  if (path === ".") return scope["."];
  const parts = path.split(".");
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as TestScope)[p];
  }
  return cur;
}

function renderHistorical(template: string, scope: TestScope, warnings: string[]): string {
  let out = template.replaceAll(
    /\{\{#each\s+([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_m: string, path: string, inner: string) => {
      const arr = lookupHistorical(scope, path);
      if (!Array.isArray(arr)) {
        warnings.push(`template: {{#each ${path}}} expected array`);
        return "";
      }
      return arr
        .map((item: unknown) => {
          const child =
            typeof item === "object" && item !== null
              ? { ...scope, ...(item as TestScope), ".": item }
              : { ...scope, ".": item };
          return renderHistorical(inner, child, warnings);
        })
        .join("");
    },
  );

  out = out.replaceAll(
    /\{\{#if\s+([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_m: string, path: string, inner: string) => {
      const v = lookupHistorical(scope, path);
      const truthy = Array.isArray(v) ? v.length > 0 : Boolean(v);
      return truthy ? renderHistorical(inner, scope, warnings) : "";
    },
  );

  out = out.replaceAll(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_m: string, path: string) => {
    const v = lookupHistorical(scope, path);
    if (v === undefined || v === null) {
      warnings.push(`template: {{${path}}} missing`);
      return "";
    }
    return typeof v === "string" ? v : JSON.stringify(v);
  });

  return out;
}

function braceFreeFixtureScope(): TestScope {
  return {
    date: "2026-09-01",
    period: "pm",
    project: "penumbra",
    repo_root: "/repo/penumbra",
    session_stamp_value: "2026-09-01T12:00:00Z",
    recall: {
      dispatch_events: [{ handoff_id: "h1", kind: "dispatch.end" }],
      dispatch_summaries: [
        {
          agent: "codex-acp-fast",
          duration_seconds: 12,
          failed_event_kinds: "",
          handoff_id: "h1",
          outcome: "complete",
        },
      ],
      file: { contents: { body: "Pending handoff draft body" } },
      git: {
        diff: "diff --git a/file b/file",
        log: "abc1234 subject line",
        show: [{ body: "Commit body text", sha: "abc1234", subject: "Subject line" }],
      },
      handoff_list_pending: [{ handoff_id: "h2", message: "Pending message", status: "pending" }],
      latest_continuation_note: { body: "Newest continuation note body" },
      memory_search: [{ id: "mem1", snippet: "Recent memory snippet", title: "Recent memory" }],
      registrar_status: [
        {
          last_event_id: "evt1",
          phases: "phase-a",
          registrar_id: "reg1",
          rollup: { open_blockers: 0, open_follow_ups: 1 },
          slug: "alpha",
          status: "active",
        },
      ],
      routing_bias_list: [
        {
          expires_at: "2026-09-01T13:00:00Z",
          mode: "prefer",
          reason: "fixture",
          scope: "agent",
          value: "codex-acp-fast",
        },
      ],
      session_first_moves: {
        daemon_healthy: true,
        daemon_pid: 123,
        gate_deltas: "none",
        git_status_dirty_count: 0,
        head_sha: "abc1234",
        open_lanes: 0,
        open_prs: {
          prs: [
            {
              author: "second-account",
              checks: "success",
              created_at: "2026-09-21T10:00:00Z",
              foreign_author: true,
              head_ref: "feat/other-account",
              not_from_known_lane: true,
              number: 74,
              title: "Implement #71",
            },
            {
              author: "maestro",
              checks: "failure",
              created_at: "2026-09-21T11:00:00Z",
              foreign_author: false,
              head_ref: "fix/issue-71_abcd1234",
              not_from_known_lane: false,
              number: 78,
              title: "Fix #71",
            },
          ],
          reason: null,
        },
        origin_main_sha: "def5678",
        pending_handoffs: 1,
        pending_task_drafts: 2,
        pin_share: "0.10",
        unpushed: 0,
        worker_count: 2,
        worker_pids: "1234,5678",
      },
    },
  };
}

test("substitutes simple {{path}}", () => {
  expect(renderTemplate("hello {{name}}", { name: "world" })).toBe("hello world");
});

test("substitutes nested path {{a.b.c}}", () => {
  expect(renderTemplate("{{a.b.c}}", { a: { b: { c: "X" } } })).toBe("X");
});

test("renders {{#each}} array iteration", () => {
  const tpl = `{{#each items}}- {{name}}\n{{/each}}`;
  expect(renderTemplate(tpl, { items: [{ name: "a" }, { name: "b" }] })).toBe("- a\n- b\n");
});

test("renders {{.}} inside {{#each}} over scalar array", () => {
  const tpl = `{{#each items}}- {{.}}\n{{/each}}`;
  expect(renderTemplate(tpl, { items: ["alpha", "beta"] })).toBe("- alpha\n- beta\n");
});

test("still renders named accessors when items are objects", () => {
  const tpl = `{{#each items}}- {{name}}\n{{/each}}`;
  expect(renderTemplate(tpl, { items: [{ name: "a" }, { name: "b" }] })).toBe("- a\n- b\n");
});

test("renders {{#if}} when truthy", () => {
  const tpl = `{{#if has}}YES{{/if}}{{#if missing}}NO{{/if}}`;
  expect(renderTemplate(tpl, { has: true, missing: false })).toBe("YES");
});

test("leaves missing vars as empty string and pushes to warnings", () => {
  const warnings: string[] = [];
  expect(renderTemplate("{{missing}}", {}, { warnings })).toBe("");
  expect(warnings.length).toBe(1);
});

test("warns with the missing template token and renders it empty", () => {
  const warnings: string[] = [];
  expect(renderTemplate("before {{missing}} after", {}, { warnings })).toBe("before  after");
  expect(warnings).toEqual(["template: {{missing}} missing"]);
});

test("escapes nothing — output is plain text", () => {
  expect(renderTemplate("{{x}}", { x: "<html>" })).toBe("<html>");
});

test("preserves braces inside a substituted string value without warnings", () => {
  const warnings: string[] = [];
  const output = renderTemplate(
    "{{#if enabled}}{{body}}{{/if}}",
    {
      body: "TemplateVarContext.sessionId, {{session_id}}, and {{now_minus_24h}};",
      enabled: true,
    },
    { warnings },
  );

  expect(output).toBe("TemplateVarContext.sessionId, {{session_id}}, and {{now_minus_24h}};");
  expect(warnings).toEqual([]);
});

test("preserves block-looking text inside a substituted value without executing it", () => {
  const warnings: string[] = [];
  const output = renderTemplate(
    "{{#if enabled}}{{body}}{{/if}}",
    {
      body: "{{#each items}}item {{name}}{{/each}}",
      enabled: true,
      items: [{ name: "executed" }],
    },
    { warnings },
  );

  expect(output).toBe("{{#each items}}item {{name}}{{/each}}");
  expect(warnings).toEqual([]);
});

test("preserves braces in values substituted inside {{#each}} blocks", () => {
  const warnings: string[] = [];
  const output = renderTemplate(
    "{{#each items}}- {{body}}\n{{/each}}",
    {
      items: [{ body: "literal {{session_id}}" }, { body: "literal {{now_minus_24h}}" }],
    },
    { warnings },
  );

  expect(output).toBe("- literal {{session_id}}\n- literal {{now_minus_24h}}\n");
  expect(warnings).toEqual([]);
});

test("matches historical output for real brace-free session playbooks", () => {
  const scope = braceFreeFixtureScope();
  const playbooks = [
    "plugin/playbooks/session-handoff/playbook.md",
    "plugin/playbooks/maestro-context-prime/playbook.md",
  ];

  for (const path of playbooks) {
    const spec = loadMarkdownPlaybook(path);
    if (spec.run.kind !== "markdown-template") {
      throw new Error(`${path} is not a markdown template`);
    }

    const historicalWarnings: string[] = [];
    const warnings: string[] = [];
    const historical = renderHistorical(spec.run.template, scope, historicalWarnings);
    const rendered = renderTemplate(spec.run.template, scope, { warnings });

    expect(rendered).toBe(historical);
    expect(warnings).toEqual(historicalWarnings);
  }
});

function renderPlaybook(path: string, scope: TestScope, warnings: string[]): string {
  const spec = loadMarkdownPlaybook(path);
  if (spec.run.kind !== "markdown-template") {
    throw new Error(`${path} is not a markdown template`);
  }
  return renderTemplate(spec.run.template, scope, { warnings });
}

function withOpenPrs(openPrs: unknown): TestScope {
  const scope = braceFreeFixtureScope();
  const recall = scope["recall"] as TestScope;
  return {
    ...scope,
    recall: {
      ...recall,
      session_first_moves: {
        ...(recall["session_first_moves"] as TestScope),
        open_prs: openPrs,
      },
    },
  };
}

test("session-handoff skeleton lists open PRs and flags foreign authors and heads not from a known lane", () => {
  const warnings: string[] = [];
  const rendered = renderPlaybook(
    "plugin/playbooks/session-handoff/playbook.md",
    braceFreeFixtureScope(),
    warnings,
  );

  expect(rendered).toContain(
    "- #74 Implement #71 — `feat/other-account` by second-account, opened 2026-09-21T10:00:00Z, checks success — **not authored by this gh account** — **not from a known lane**\n",
  );
  expect(rendered).toContain(
    "- #78 Fix #71 — `fix/issue-71_abcd1234` by maestro, opened 2026-09-21T11:00:00Z, checks failure\n",
  );
  expect(rendered).not.toContain("Unavailable:");
  expect(warnings.filter((warning) => warning.includes("open_prs"))).toEqual([]);
});

test("session-handoff skeleton says why open PRs are unavailable", () => {
  const warnings: string[] = [];
  const rendered = renderPlaybook(
    "plugin/playbooks/session-handoff/playbook.md",
    withOpenPrs({ prs: null, reason: "gh not installed" }),
    warnings,
  );

  expect(rendered).toContain("\nUnavailable: gh not installed\n");
  expect(rendered).not.toContain("- #");
  expect(warnings.filter((warning) => warning.includes("open_prs"))).toEqual([]);
});

test("maestro-context-prime first moves include open_prs", () => {
  const rendered = renderPlaybook(
    "plugin/playbooks/maestro-context-prime/playbook.md",
    withOpenPrs({ prs: null, reason: "not a GitHub repository" }),
    [],
  );

  expect(rendered).toContain('- open_prs: {"prs":null,"reason":"not a GitHub repository"}\n');
});

test("maestro-context-prime first moves carry each open PR's foreign_author flag", () => {
  const rendered = renderPlaybook(
    "plugin/playbooks/maestro-context-prime/playbook.md",
    braceFreeFixtureScope(),
    [],
  );

  expect(rendered).toContain('"foreign_author":true,"head_ref":"feat/other-account"');
  expect(rendered).toContain('"foreign_author":false,"head_ref":"fix/issue-71_abcd1234"');
});
