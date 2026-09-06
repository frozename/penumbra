export const meta = {
  name: "session-first-moves",
  description:
    "Collect session-start diagnostics: git status, daemon health, handoffs, task drafts, gate deltas, open lanes. Optionally run Phase-5 soak checks.",
  whenToUse:
    "At session start to get a quick overview of workspace and daemon state, or as a Phase-5 soak verification step.",
  phases: [
    {
      title: "Collect",
      detail:
        "run session-first-moves collector via a single agent() call and return the validated result",
    },
  ],
};

let input = args;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch {
    throw new Error("session-first-moves: args is not valid JSON: " + input.slice(0, 300));
  }
}

const soak = !!(input && input.soak);

const nullable = ({ type, ...rest }) => ({ ...rest, type: [type, "null"] });

const SFM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["git_status_dirty_count", "daemon_healthy", "gate_deltas"],
  properties: {
    git_status_dirty_count: {
      type: "integer",
      description: "Number of dirty files from git status --porcelain",
    },
    head_sha: nullable({ type: "string", description: "Current HEAD commit SHA" }),
    origin_main_sha: nullable({ type: "string", description: "SHA of origin/main" }),
    daemon_pid: nullable({
      type: "integer",
      description: "PID of the penumbra daemon from launchctl",
    }),
    daemon_healthy: { type: "boolean", description: "Whether the daemon health check passed" },
    worker_count: nullable({
      type: "integer",
      description: "Number of active workers (always null, no endpoint)",
    }),
    pending_handoffs: nullable({ type: "integer", description: "Count of pending handoffs" }),
    pending_task_drafts: nullable({ type: "integer", description: "Count of pending task drafts" }),
    gate_deltas: {
      type: "object",
      additionalProperties: false,
      required: ["filtered", "neardup"],
      properties: {
        filtered: nullable({ type: "integer", description: "Count of promotion-filtered rollups" }),
        neardup: nullable({ type: "integer", description: "Count of near-dup gate actions" }),
      },
      description: "Memory gate delta counts",
    },
    open_lanes: nullable({ type: "integer", description: "Count of open lanes" }),
    pin_share: {
      type: ["object", "null"],
      description: "Dispatch pin-share from handoffs: role_route vs pinned (NULL reason), 24h/7d, plus the steerable subset (dispatch_kind NULL/workflow). Return verbatim from the collector.",
    },
  },
};

const SOAK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["git_status_dirty_count", "daemon_healthy", "gate_deltas", "soak"],
  properties: {
    git_status_dirty_count: { type: "integer" },
    head_sha: nullable({ type: "string" }),
    origin_main_sha: nullable({ type: "string" }),
    daemon_pid: nullable({ type: "integer" }),
    daemon_healthy: { type: "boolean" },
    worker_count: nullable({ type: "integer" }),
    pending_handoffs: nullable({ type: "integer" }),
    pending_task_drafts: nullable({ type: "integer" }),
    gate_deltas: {
      type: "object",
      additionalProperties: false,
      required: ["filtered", "neardup"],
      properties: {
        filtered: nullable({ type: "integer" }),
        neardup: nullable({ type: "integer" }),
      },
    },
    open_lanes: nullable({ type: "integer" }),
    pin_share: {
      type: ["object", "null"],
      description: "Dispatch pin-share from handoffs: role_route vs pinned (NULL reason), 24h/7d, plus the steerable subset (dispatch_kind NULL/workflow). Return verbatim from the collector.",
    },
    soak: {
      type: "object",
      additionalProperties: false,
      required: ["sentinel_ok", "double_run_detected"],
      properties: {
        sentinel_ok: {
          type: "boolean",
          description: "Whether all project MEMORY.md first lines are intact",
        },
        double_run_detected: {
          type: "boolean",
          description: "Whether a renderer double-run was detected via .prev file comparison",
        },
      },
    },
  },
};

const activeSchema = soak ? SOAK_SCHEMA : SFM_SCHEMA;

const promptParts = [
  "Run `bun scripts/session-first-moves.ts` and capture the JSON it outputs to stdout.",
  "Parse the JSON and return it verbatim as your structured output.",
  "Do not modify, summarize, or interpret the data — return the exact parsed object.",
];

if (soak) {
  promptParts.push(
    "",
    "After parsing the collector output, also run the Phase-5 soak checks:",
    "1. Check cross-project MEMORY.md sentinel first lines: for each directory under ~/.claude/projects/*/memory/MEMORY.md, verify the first line is not empty and does not look corrupted.",
    "2. Check for renderer double-run detection: compare .prev files (if any) in the worktree to detect double-run artifacts.",
    'Add the results as a "soak" object: { sentinel_ok: <boolean>, double_run_detected: <boolean> }.',
  );
}

phase("Collect");

const result = await agent(promptParts.join("\n"), {
  label: "session-first-moves",
  phase: "Collect",
  schema: activeSchema,
});

return result;
