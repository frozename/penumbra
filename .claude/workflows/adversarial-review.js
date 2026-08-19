export const meta = {
  name: "adversarial-review",
  description:
    "CC-runtime port of the penumbra adversarial-review. Runs the proven DAEMON multi-persona fleet review (config-driven personas + agent_performance capture preserved) and returns SCHEMA-VALIDATED typed findings (severity buckets as data, not synthesis.md prose). Optionally drives the dispatch-quality-gates lifecycle inline: one fix-round for HIGH findings under the 2-round cap, an independent grader that can reject regression-risk fixes, then a recommended lane_close gate_status. Wraps the daemon workflow rather than reimplementing personas. Lands nothing.",
  whenToUse:
    "When you want adversarial-review findings as typed data (to feed lane_close metadata or branch on HIGH counts), or want review -> fix -> independent grade -> re-review codified in one run. Args { target_ref, base_ref?, fixRound?, laneId?, fixAgent?, graderModel?, taskIntent? }.",
  phases: [
    {
      title: "Review",
      detail:
        "run daemon adversarial-review (watchdog-safe poll) + parse synthesis to typed findings",
    },
    {
      title: "Fix",
      detail:
        "optional: dispatch a fix for HIGH findings, grade it independently, then re-review if not rejected (2-round cap)",
    },
    {
      title: "Grade",
      detail: "independent grader refutes the fix diff and rejects regression-risk changes",
    },
  ],
};

// ---- args ----
// args: { target_ref, base_ref?, fixRound?, laneId?, fixAgent?, graderModel?, taskIntent? }
// graderModel defaults to 'sonnet'; pass graderModel:'inherit' to use the session-default model.
let a = args;
if (typeof a === "string") {
  try {
    a = JSON.parse(a);
  } catch {
    throw new Error("args was a string but not valid JSON: " + a);
  }
}
const target_ref = (a && a.target_ref) || "HEAD";
const base_ref = (a && a.base_ref) || "main";
const fixRound = !!(a && a.fixRound);
const laneId = a && a.laneId;
const fixAgent = (a && a.fixAgent) || "openai-codex-deep-acp";
const graderModel = a && a.graderModel;
const taskIntent =
  (a && a.taskIntent) ||
  `Preserve the intent of the pre-fix diff ${base_ref}..${target_ref}: address only the HIGH review findings without reverting, weakening, or deleting unrelated existing behavior.`;
const REPO = ((typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : (args || {})).repo) || (typeof process !== "undefined" ? (process.env.PENUMBRA_REPO || process.cwd()) : ".");

// ---- schemas (typed findings — the primary payoff over parsing synthesis.md) ----
const FINDING = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "title"],
  properties: {
    id: { type: "string", description: "e.g. F1" },
    severity: { type: "string", enum: ["high", "medium", "low"] },
    personas: { type: "string", description: "comma-list of personas that raised it" },
    file: { type: "string" },
    title: { type: "string" },
    detail: { type: "string" },
    fix: { type: "string" },
  },
};
const SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "high", "medium", "low", "completed_personas"],
  properties: {
    outcome: { type: "string" },
    verdict: {
      type: "string",
      description: "land | land_with_revisions | block — the synthesis.md headline sense, verbatim",
    },
    shared_concerns: { type: "string" },
    high: { type: "array", items: FINDING },
    medium: { type: "array", items: FINDING },
    low: { type: "array", items: FINDING },
    completed_personas: { type: "array", items: { type: "string" } },
    failed_personas: { type: "array", items: { type: "string" } },
    synthesis_path: { type: "string" },
    out_dir: { type: "string" },
    persona_handoff_ids: {
      type: "string",
      description:
        "verbatim persona->handoff_id mapping from synthesis.md frontmatter (JSON or text)",
    },
    synthesis_handoff_id: { type: "string" },
  },
};
const FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["handoff_id", "branch", "commit_count", "status"],
  properties: {
    handoff_id: { type: "string" },
    branch: { type: "string", description: "handoff branch_name or MISSING" },
    branch_tip: { type: "string" },
    commit_count: { type: "integer" },
    status: { type: "string" },
    notes: { type: "string" },
  },
};
const GRADE_FINDING = {
  type: "object",
  additionalProperties: false,
  required: ["finding_id", "addressed", "regression_risk", "evidence"],
  properties: {
    finding_id: { type: "string" },
    addressed: { type: "boolean" },
    regression_risk: { type: "boolean" },
    evidence: { type: "string" },
  },
};
const GRADER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: { type: "array", items: GRADE_FINDING },
    notes: { type: "string" },
  },
};

// The daemon adversarial-review takes ~7min; a blocking workflow_run(wait:true) inside a
// workflow agent would exceed the 180s workflow watchdog and get killed+retried (duplicate
// daemon runs). So: dispatch async (wait:false) and POLL in <=150s increments. See memory
// cc-workflow-180s-watchdog.
function reviewPrompt(ref) {
  return [
    `Run the penumbra DAEMON adversarial-review over a diff and return its findings as TYPED data. Report only verbatim values from tool results; never invent a handoff_id.`,
    `YOU ARE A PROXY — your ONLY job is to dispatch the daemon review, poll it, and parse its synthesis. You MUST NOT read, diff, or review the code yourself. If you ever find yourself running \`git diff\`/\`git show\` or analyzing the implementation, STOP — that is wrong, it is not your job, and a long manual review trips the no-progress watchdog (kill+retry+thrash). On ANY failure (STEP 1 workflow_run errors; STEP 3 result.outcome is "failed"; or there is no synthesis_path), DO NOT fall back to a manual inline review — instead return SYNTHESIS_SCHEMA with verdict="block", shared_concerns="daemon adversarial-review unavailable: <verbatim reason>", empty high/medium/low arrays, completed_personas=[], and failed_personas=["daemon-review-failed"].`,
    `STEP 1: mcp__penumbra__workflow_run name="adversarial-review", wait=false, args={ base_ref: "${base_ref}", target_ref: "${ref}" }. Copy the workflow_run_id verbatim. If this call itself errors, apply the PROXY failure rule above and return immediately.`,
    `  (This fans personas out on the penumbra fleet — preserving agent_performance capture + config personas. Do NOT reimplement personas.)`,
    `STEP 2 (watchdog-safe poll — do NOT use wait=true, it would block >180s and trip the workflow watchdog -> duplicate runs): loop mcp__penumbra__workflow_wait with timeout_ms=150000 (one call per step) until status is terminal (completed/failed), for AT MOST 12 iterations (~30min). On timeout, call it again. If still not terminal after 12 polls, apply the PROXY failure rule (verdict="block", failed_personas=["daemon-review-timeout"]) and return. Never a single block longer than ~150s, and never substitute your own review for the daemon's.`,
    `STEP 3: from the terminal result.runResult read: outcome, completed_personas, failed_personas, out_dir, synthesis_path, synthesis_handoff_id (if present).`,
    `STEP 4: read the synthesis markdown at synthesis_path. Parse YAML frontmatter for persona_handoff_ids + synthesis_handoff_id (verbatim). Parse the body: headline verdict (land / land with revisions / block), shared concerns, and EVERY finding under the HIGH / MEDIUM / LOW headings (id like F1, title, the personas that raised it, file, detail, fix).`,
    `STEP 5: return SYNTHESIS_SCHEMA. Place each finding in high/medium/low by its heading. completed_personas/failed_personas and outcome from STEP 3. Every handoff_id verbatim from a tool result.`,
  ].join("\n");
}

function graderPrompt(preFixBranch, fixBranch, highList) {
  return [
    `You are an independent adversarial grader for a fix round. You are NOT the fix agent. Your job is to REFUTE the work, not confirm it. Do not edit, dispatch, land, or push anything.`,
    ``,
    `Original task intent:`,
    taskIntent,
    ``,
    `HIGH findings the fix claimed to address:`,
    highList,
    ``,
    `Inspect both diffs in ${REPO}:`,
    `1. PRE-FIX branch vs base: git diff ${base_ref}...${preFixBranch}`,
    `2. FIX branch vs pre-fix branch: git diff ${preFixBranch}...${fixBranch}`,
    ``,
    `For each HIGH finding, decide addressed=true only when the fix diff materially resolves that finding. Set regression_risk=true if the fix diff appears to revert, remove, weaken, or bypass behavior from the pre-fix branch, especially tests or exits related to the finding. Evidence must cite concrete files, hunks, commands, or observed diff facts.`,
    `Return GRADER_SCHEMA with one object per original HIGH finding. Never invent findings that were not in the HIGH list.`,
  ].join("\n");
}

phase("Review");
let review = await agent(reviewPrompt(target_ref), {
  label: "review:round1",
  phase: "Review",
  schema: SYNTHESIS_SCHEMA,
  // synthesis parse is a capable read/extract task — Sonnet, not Haiku.
  model: "sonnet",
});
log(
  `round1: verdict="${review.verdict}" high=${review.high.length} medium=${review.medium.length} low=${review.low.length} personas=${review.completed_personas.length}`,
);

let fix = null;
let fixGrade = null;
let fixRoundStatus = "NOT_RUN";
let landCandidate = target_ref;
let landCandidateReason = "pre-fix reviewed branch";
let rounds = 1;

if (fixRound && review.high.length > 0) {
  phase("Fix");
  const highList = review.high
    .map(
      (f, i) =>
        `${f.id || "H" + (i + 1)} [${f.severity}] ${f.title}${f.file ? " (" + f.file + ")" : ""}: ${f.detail || ""}${f.fix ? " FIX: " + f.fix : ""}`,
    )
    .join("\n");
  fix = await agent(
    [
      `Dispatch ONE fix task to the penumbra fleet for the HIGH adversarial-review findings below, then report verbatim branch facts.`,
      `STEP 1: mcp__penumbra__chain_start initial_agent="${fixAgent}", task_class="BOUNDARY", task_type="implement_small", task_name="review-fixes", caller_cwd="${REPO}", branch_base="${target_ref}", branch_type="fix", message = a contract that: addresses ONLY these HIGH findings, writes/updates a failing test first, keeps scope tight, commits with a NEUTRAL message (zero AI/assistant/co-authored attribution), and runs its own typecheck + tests. Findings:`,
      highList,
      `STEP 2: copy handoff_id and provisional branch_name verbatim from the chain_start result; the chain_start value is provisional because a collision suffix may be applied by the worker.`,
      `STEP 3 (watchdog-safe): poll mcp__penumbra__chain_status / chain_wait (<=150s per call) until terminal. Take the FINAL branch_name from the terminal chain_wait or chain_status result; fallback to the chain_start value only if the terminal result lacks it.`,
      `STEP 4: in ${REPO}: git rev-parse --verify --quiet <branch_name> (branch_tip; "MISSING" if absent); git rev-list --count main..<branch_name> (commit_count).`,
      `Return FIX_SCHEMA with verbatim values.`,
    ].join("\n"),
    { label: "fix:round1", phase: "Fix", schema: FIX_SCHEMA, model: "sonnet" },
  );
  log(`fix dispatched: branch=${fix.branch} commits=${fix.commit_count} status=${fix.status}`);

  if (fix && fix.branch !== "MISSING" && fix.commit_count > 0) {
    rounds = 2; // the cap: at most one fix + one re-review
    phase("Grade");
    fixGrade = await agent(graderPrompt(target_ref, fix.branch, highList), {
      label: "grade:round1",
      phase: "Grade",
      schema: GRADER_SCHEMA,
      ...(graderModel === "inherit" ? {} : { model: graderModel || "sonnet" }),
    });
    const hasRegressionRisk = !!(
      fixGrade &&
      Array.isArray(fixGrade.findings) &&
      fixGrade.findings.some((f) => f.regression_risk)
    );
    // A dead/skipped grader (agent() -> null) must NOT bless the fix — that is the
    // exact self-reported-success failure mode this stage exists to catch.
    fixRoundStatus =
      fixGrade === null ? "GRADER_UNAVAILABLE" : hasRegressionRisk ? "REJECTED" : "ACCEPTED";
    if (fixRoundStatus !== "ACCEPTED") {
      landCandidate = target_ref;
      landCandidateReason =
        fixRoundStatus === "GRADER_UNAVAILABLE"
          ? "grader unavailable (agent returned null); fix branch not attested — land candidate stays the pre-fix branch"
          : "fix round rejected by independent grader because regression_risk=true";
      log(
        `fix grade: ${fixRoundStatus} branch=${fix.branch}; land candidate remains ${landCandidate}`,
      );
    } else {
      landCandidate = fix.branch;
      landCandidateReason = "fix round accepted by independent grader";
      log(`fix grade: ACCEPTED branch=${fix.branch}; re-reviewing`);
      review = await agent(reviewPrompt(fix.branch), {
        label: "review:round2",
        phase: "Fix",
        schema: SYNTHESIS_SCHEMA,
        model: "sonnet",
      });
      log(
        `round2: verdict="${review.verdict}" high=${review.high.length} medium=${review.medium.length} low=${review.low.length}`,
      );
    }
  } else {
    fixRoundStatus = "FAILED";
  }
}

// Gate decision (2-round cap): clean -> passed; HIGH remain after the cap -> review_debt; else failed.
// The workflow RECOMMENDS the close; the maestro stays the lane authority (and given the
// lane_ledger_recent read quirk, lane mutation stays an explicit maestro step).
let laneRecommendation = null;
if (laneId) {
  const gate = review.high.length === 0 ? "passed" : rounds >= 2 ? "review_debt" : "failed";
  laneRecommendation = {
    laneId,
    gate_status: gate,
    round_count: rounds,
    metadata: {
      high_findings: review.high.length,
      medium_findings: review.medium.length,
      low_findings: review.low.length,
      round_count: rounds,
      fix_round_status: fixRoundStatus,
    },
  };
  log(`lane recommendation: lane_close(${laneId}, gate_status=${gate}, round_count=${rounds})`);
}

return {
  ranNothingToMain: true,
  target_ref,
  base_ref,
  rounds,
  outcome: review.outcome,
  verdict: review.verdict,  high: review.high,
  medium: review.medium,
  low: review.low,
  high_count: review.high.length,
  medium_count: review.medium.length,
  low_count: review.low.length,
  completed_personas: review.completed_personas,
  failed_personas: review.failed_personas,
  synthesis_path: review.synthesis_path,
  persona_handoff_ids: review.persona_handoff_ids,
  fix,
  fix_grade: fixGrade,
  fix_round_status: fixRoundStatus,
  fix_rejected: fixRoundStatus === "REJECTED" || fixRoundStatus === "GRADER_UNAVAILABLE",
  land_candidate: landCandidate,
  land_candidate_reason: landCandidateReason,
  laneRecommendation,
  next:
    fixRoundStatus === "REJECTED" || fixRoundStatus === "GRADER_UNAVAILABLE"
      ? `Fix round ${fixRoundStatus} (independent grader); land candidate remains PRE-fix branch ${landCandidate}. Do not land ${fix && fix.branch ? fix.branch : "the fix branch"} without explicit override.`
      : review.high.length === 0
        ? `No HIGH findings outstanding — maestro may land ${landCandidate} (land -> verify HEAD+content in main -> push -> teardown).`
        : `${review.high.length} HIGH finding(s) outstanding after ${rounds} round(s). 2-round cap reached if rounds==2 -> lane_close review_debt (or override with a written reason). A third fix round is NOT auto-run.`,
};
