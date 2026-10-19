import { expect, test } from "bun:test";

import { parsePlanMeta } from "@src/plan-meta/parser.js";
import { PlanHeaderSchema, TaskMetaSchema } from "@src/plan-meta/schema.js";

test("TaskMeta accepts qualified depends_on", () => {
  const r = TaskMetaSchema.safeParse({
    id: "1.1",
    files: ["x.ts"],
    file_scope: "new",
    depends_on: ["penumbra/2.1", "1.2"],
    parallel_with: [],
    preferred_agent: "codex-acp-fast",
    fallback_agent: "claude-acp-sonnet",
    task_size: "small",
    risk_class: "paste-ready",
  });
  expect(r.success).toBe(true);
});

test("TaskMeta rejects malformed qualified id", () => {
  for (const bad of ["/1.1", "1.1/", "Penumbra/1.1", "a/", "/a"]) {
    const r = TaskMetaSchema.safeParse({
      id: "1.1",
      files: ["x.ts"],
      file_scope: "new",
      depends_on: [bad],
      parallel_with: [],
      preferred_agent: "codex-acp-fast",
      fallback_agent: "claude-acp-sonnet",
      task_size: "small",
      risk_class: "paste-ready",
    });
    expect(r.success).toBe(false);
  }
});

test("TaskMeta accepts optional project field", () => {
  const r = TaskMetaSchema.safeParse({
    id: "1.1",
    files: ["x.ts"],
    file_scope: "new",
    depends_on: [],
    parallel_with: [],
    preferred_agent: "codex-acp-fast",
    fallback_agent: "claude-acp-sonnet",
    task_size: "small",
    risk_class: "paste-ready",
    project: "embersynth",
  });
  expect(r.success).toBe(true);
});

test("PlanHeaderSchema parses minimal valid header", () => {
  const r = PlanHeaderSchema.safeParse({
    plan_id: "demo",
    home_project: "penumbra",
  });
  expect(r.success).toBe(true);
});

test("PlanHeaderSchema rejects invalid home_project", () => {
  const r = PlanHeaderSchema.safeParse({
    plan_id: "demo",
    home_project: "CAPITALIZED",
  });
  expect(r.success).toBe(false);
});

test("parser yields header from fixture", () => {
  const md = `---
plan_id: demo
home_project: penumbra
---

## Phase 1

### Task 1.1

\`\`\`yaml meta
id: '1.1'
files: [x.ts]
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
\`\`\`
`;
  const r = parsePlanMeta(md);
  expect(r.header?.home_project).toBe("penumbra");
  expect(r.tasks.length).toBe(1);
});

test("parser tolerates missing header - backwards compat", () => {
  const md = `## Phase 1

### Task 1.1

\`\`\`yaml meta
id: '1.1'
files: [x.ts]
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
\`\`\`
`;
  const r = parsePlanMeta(md);
  expect(r.header).toBeUndefined();
  expect(r.tasks.length).toBe(1);
});

const TASK_BLOCK = `\`\`\`yaml meta
id: '1.1'
files: [x.ts]
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
\`\`\``;

test("parser reports a header that fails the schema instead of dropping it", () => {
  const md = `---
home_project: penumbra
---

### Task 1.1

${TASK_BLOCK}
`;
  const r = parsePlanMeta(md);
  expect(r.header).toBeUndefined();
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0]?.line).toBe(1);
  expect(r.errors[0]?.reason).toContain("invalid plan header");
  expect(r.errors[0]?.reason).toContain("plan_id");
  expect(r.tasks.length).toBe(1);
});

test("parser reads --- after the first line as a thematic break, not a header", () => {
  const md = `# Plan

**Goal:** demo

---

### Task 1.1

${TASK_BLOCK}

---
`;
  const r = parsePlanMeta(md);
  expect(r.header).toBeUndefined();
  expect(r.errors).toEqual([]);
  expect(r.tasks.map((task) => task.id)).toEqual(["1.1"]);
});
