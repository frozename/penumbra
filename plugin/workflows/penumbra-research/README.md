# penumbra-research

Memory-augmented web research: prime with penumbra t2 memory, fan out sourced web
research across sub-questions via the shared `runFanout`, synthesize a cited report,
and write it to `out_dir`.

This is the native (`plugin/workflows/`) port of `.claude/workflows/penumbra-research.js`.
It uses the shared `runFanout` primitive (real `chainStart` + dispatch-reliability
classifier) for every stage — no direct `ctx.dispatch`, no hand-rolled wait loops.

## Args (strict)

| arg               | type     | default       | notes                                             |
| ----------------- | -------- | ------------- | ------------------------------------------------- |
| `question`        | string   | —             | required, trimmed nonempty, ≤2000 chars           |
| `angles`          | int 1..6 | 4             | number of research sub-questions                  |
| `web_agent`       | string   | —             | explicit web-capable seat; overrides config       |
| `planner_agent`   | string   | `executor`    | tool-free decomposition seat                      |
| `synthesis_agent` | string   | `executor`    | tool-free synthesis seat                          |
| `persist`         | boolean  | `true`        | whether to return a `memory_candidate`            |
| `timeout_ms`      | int >0   | `1800000`     | per-task wait budget                              |
| `out_dir`         | string   | `research`    | report artifact directory (under cwd/storageRoot) |
| `project_id`      | string   | `ctx.project` | project scope for prime + dispatch                |

## Web seat resolution

The web seat is resolved from the explicit `web_agent` arg, or from
`config.workloads.web_research.eligible_agents` (duck-typed, shape-verified). If
neither is present the workflow returns `{ ok: false, error: "no_web_capable_seat" }`
**before any dispatch or report write** — no fabricated seat, no off-adapter or
local-network fallback. The strict `WorkloadsConfigSchema` does not list
`web_research`, so by default this fails closed unless the operator opts in.

## Stages

1. **Prime** — reads `t2_fts JOIN t2_memories` with bound params, a punctuation-safe
   OR-joined FTS query, project scope, and untrusted-metadata exclusion. Max 6 hits,
   titles bounded to 120 chars, bodies to 400. Memory content is data, not
   instructions. No t2 writes, no embedder, no new-memory API.
2. **Planner** — one tool-free `runFanout` task that must return exactly `angles`
   independent, nonempty, unique, bounded sub-questions. Malformed, duplicate, or
   wrong-cardinality arrays are rejected in full rather than sanitized.
3. **Research** — one `runFanout` per sub-question (web seat, `tool_free: false`).
   Each receipt must have sourced findings and 2–12 unique, credential-free `http(s)`
   URLs spanning at least two normalized hostnames, a nonempty findings body, and the
   exact dispatched sub-question. Host diversity is necessary but does not by itself
   prove editorial independence or actual browser/tool use. Dispatch reliability is
   owned by `runFanout` (real core classifier). Fail-closed: **all** requested angles
   must be valid for full success — failures are not silently filtered.
4. **Synthesis** — one tool-free `runFanout` task. Its 1–72 sources must be valid,
   unique URLs that are a canonicalized subset of the accepted angle URLs; empty,
   malformed, duplicate, and invented source lists are rejected.
5. **Artifact** — the full report is written **only** to `out_dir` via
   `ctx.fileWrite`; the exact path receipt is verified. An invalid receipt or a
   throw fails closed — no best-effort `ok: true`.

## No native t2 write path

`persisted` is **always `false`**. When `persist` is requested,
`persistence_reason` is `no_native_t2_write_path`. This workflow does not write to
t2 memory — there is no native t2 write path. When `persist` is `true`, a bounded `memory_candidate`
(question, summary, source URLs, report path) is returned as **data** for the caller
to optionally persist via `memory_observe` if it wants cross-session recall. This is
an intentional lack of durable memory write; do not claim full parity with the
`.claude/` workflow's persist phase, which dispatched a `memory_observe` call.

## Return shape (bounded; no full body inline)

```
{
  ok, question, prior_brief, subquestions,
  angles_requested, angles_valid,
  findings: [{ subquestion, sources, findings_excerpt }],  // excerpt ≤400 chars
  sources, summary, report_path,
  persisted: false, persistence_reason: "no_native_t2_write_path" | null,
  memory_candidate: { question, summary, source_urls, report_path } | null
}
```

The full report and full findings bodies are never returned inline — they live only
in the artifact file.

The workflow validates returned source receipts but does not independently prove that
the configured web seat invoked WebSearch/WebFetch. That runtime qualification remains
an operator-side verification requirement.
