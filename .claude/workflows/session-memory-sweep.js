export const meta = {
  name: "session-memory-sweep",
  description:
    "Collect close-time t2 memory candidates for approval, or write explicitly approved candidates to t2.",
  whenToUse:
    "At session close, pre-compact, or stop when you want Penumbra to propose durable memories before any t2 write.",
  phases: [
    { title: "Collect", detail: "run the daemon workflow and return candidate proposals" },
    { title: "Approve", detail: "write only explicitly approved candidates to t2" },
  ],
};

let input = args;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch {
    throw new Error("session-memory-sweep: args is not valid JSON: " + input.slice(0, 300));
  }
}
if (!input || typeof input !== "object") input = {};

const CANDIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "slug", "title", "body", "hook", "why"],
  properties: {
    action: { type: "string", enum: ["create", "update"] },
    slug: { type: "string" },
    update_existing_slug: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    hook: { type: "string" },
    why: { type: "string" },
    durability: { type: "string" },
    is_episodic: { type: "boolean" },
  },
};

const COLLECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "rendered_block", "candidates"],
  properties: {
    ok: { type: "boolean" },
    rendered_block: { type: "string" },
    candidates: { type: "array", items: CANDIDATE_SCHEMA },
    note: { type: "string" },
  },
};

const APPROVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "results"],
  properties: {
    ok: { type: "boolean" },
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          memory_id: { type: "string" },
          error: { type: "string" },
        },
      },
    },
  },
};

const VISUALLY_EMPTY_CHARS_RE = /[\s\p{Z}\u200B-\u200D\u2060\uFEFF]/gu;
function hasNonWhitespaceCharacter(value) {
  return typeof value === "string" && value.replaceAll(VISUALLY_EMPTY_CHARS_RE, "").length > 0;
}

if (Array.isArray(input.approve)) {
  phase("Approve");
  const approved = input.approve;
  const invalid = approved.flatMap((candidate, index) => {
    const slug =
      candidate &&
      candidate.action === "update" &&
      typeof candidate.update_existing_slug === "string"
        ? candidate.update_existing_slug
        : candidate?.slug;
    const errors = [];
    if (!hasNonWhitespaceCharacter(slug)) errors.push("missing non-blank slug");
    if (!hasNonWhitespaceCharacter(candidate?.hook)) errors.push("missing non-blank hook");
    return errors.length === 0
      ? []
      : [
          {
            slug: typeof slug === "string" ? slug : `candidate-${String(index + 1)}`,
            error: `candidate ${String(index + 1)}: ${errors.join("; ")}`,
          },
        ];
  });
  if (invalid.length > 0) {
    return { ok: false, results: invalid };
  }
  return await agent(
    [
      "Use ToolSearch to load the Penumbra memory_write_t2 MCP tool, then write each approved candidate verbatim.",
      "For update candidates, pass update_existing_slug as the slug when present; otherwise pass slug.",
      "Include title, body, hook, why, durability, is_episodic, and project_id if available. Do not alter candidate wording.",
      "Return one result per candidate with slug and memory_id or error.",
      "",
      "Approved candidates:",
      JSON.stringify(approved, null, 2),
      input.project_id ? `Project id: ${input.project_id}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    { label: "session-memory-sweep-approve", phase: "Approve", schema: APPROVE_SCHEMA },
  );
}

phase("Collect");
const currentCwd = typeof process !== "undefined" && process.cwd ? process.cwd() : null;
return await agent(
  [
    "Use ToolSearch to load the Penumbra workflow_run MCP tool.",
    `Call workflow_run with { name: 'session-memory-sweep', wait: true${currentCwd ? `, cwd: ${JSON.stringify(currentCwd)}` : ""} }.`,
    "Read the returned run result. If it contains a rendered Markdown block, return it as rendered_block and extract candidates from it into the schema.",
    "If the workflow returns an empty string, return ok:true with rendered_block:'' and candidates:[].",
    "Do not call memory_write_t2 in collect mode.",
  ].join("\n"),
  { label: "session-memory-sweep-collect", phase: "Collect", schema: COLLECT_SCHEMA },
);
