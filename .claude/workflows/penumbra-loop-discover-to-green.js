export const meta = {
  name: "penumbra-loop-discover-to-green",
  description:
    "The full improvement loop as one codified run: DISCOVER (multi-lens finders sweep a scope for the next real bug/debt) -> PLAN (a phased TDD fix spec + a concrete check command for the top candidate) -> IMPLEMENT + FIX-UNTIL-GREEN (dispatch to the fleet via penumbra-fanout and loop on the check until it passes) -> REVIEW (compose adversarial-review: the daemon multi-persona review on the green branch, with an optional fix-round + independent grade for HIGH findings). Returns a typed land recommendation. Lands NOTHING — maestro runs the authoritative land-check + dispatch_land.",
  whenToUse:
    'When you want the whole discover->plan->implement->review->fix-until-green cycle run end to end on the fleet as a rerunnable script (e.g. "do another improvement round"). Pass args.scope (where DISCOVER hunts) and optionally args.exclude, args.fixAgent, args.maxFixRounds, args.candidates, args.base, args.dryRunPlan. SEED MODE: pass args.seedCandidates = [{ title, severity, file, why_real, fix_sketch, suggested_check }] to SKIP discover and drive the plan->implement->review->fix-until-green tail on an already-triaged backlog (top-1 per run; seeds must already be verified). The codified augmentation of the penumbra loop-discover-to-green skill.',
  phases: [
    {
      title: "Discover",
      detail:
        "multi-lens finders sweep the scope; dedupe + rank worst-first; pick the top candidate",
    },
    {
      title: "Plan",
      detail:
        "a planner turns the top candidate into a phased TDD fix spec + a concrete check command",
    },
    {
      title: "Implement",
      detail:
        "dispatch to the fleet via penumbra-fanout; loop building on the prior branch until the check passes",
    },
    {
      title: "Review",
      detail:
        "compose adversarial-review: daemon multi-persona review on the green branch (+ optional HIGH fix-round + grade)",
    },
  ],
};

// ---- args (object or JSON string) ----
// {
//   scope: 'free-text description of where DISCOVER hunts',
//   exclude?: 'free-text areas to skip (e.g. already-fixed code)',
//   base?: 'main',
//   candidates?: number,         // how many candidates the ranker surfaces (default 5); top-1 goes through the loop
//   fixAgent?: 'openai-codex-deep-acp',
//   maxFixRounds?: number,       // implement/fix-until-green check rounds (default 3)
//   dryRunPlan?: boolean,        // stop after PLAN (no fleet dispatch) — useful to inspect what it would build
//   dispatcherModel?, finderModel?, plannerModel?, graderModel?
// }
//
// NOTE on composition: this workflow composes penumbra-fanout and adversarial-review via
// workflow({scriptPath}). It deliberately does NOT compose penumbra-fix-until-green via
// workflow() — that workflow itself calls workflow(penumbra-fanout), and workflow() nesting
// is one level only (a child's own workflow() call throws). So the fix-until-green loop is
// inlined here directly on top of penumbra-fanout. penumbra-fanout and adversarial-review are
// safe to compose because they use agent()/MCP, not the workflow() hook.
let a = args;
if (typeof a === "string") {
  try {
    a = JSON.parse(a);
  } catch {
    a = { scope: a };
  }
}
a = a || {};

const scope =
  a.scope ||
  "penumbra core + daemon: concurrency/transaction races, fail-open or unguarded security paths, and correctness/boundary bugs";
const exclude = a.exclude || "none";
const base = a.base || "main";
const candidateCount = Math.max(1, Math.min(10, a.candidates || 5));
const fixAgent = a.fixAgent || "openai-codex-deep-acp";
const maxFixRounds = Math.max(1, Math.min(5, a.maxFixRounds || 3));
const dryRunPlan = !!a.dryRunPlan;
const dispatcherModel = a.dispatcherModel || "sonnet";
const finderModel = a.finderModel || "sonnet";
const plannerModel = a.plannerModel || "sonnet";
const graderModel = a.graderModel;
// Seed mode: skip DISCOVER and drive the plan->implement->review->fix-until-green tail
// directly on already-discovered candidates (e.g. a triaged backlog). Pass
// args.seedCandidates = [{ title, severity, file, why_real, fix_sketch, suggested_check, confidence }].
// Seeds should already be verified — this workflow does NOT re-verify them; top-1 goes through the loop.
const seedCandidates = Array.isArray(a.seedCandidates) ? a.seedCandidates.filter(Boolean) : [];
const seedMode = seedCandidates.length > 0;

const REPO = ((typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : (args || {})).repo) || (process.env.PENUMBRA_REPO || process.cwd());

// ---- schemas ----
const CANDIDATES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "file", "why_real", "fix_sketch"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
          file: { type: "string", description: "file:line of the defect" },
          why_real: {
            type: "string",
            description: "a concrete input/sequence that produces the wrong outcome",
          },
          fix_sketch: { type: "string" },
          suggested_check: {
            type: "string",
            description: "a shell command (test slice / typecheck) that would gate the fix",
          },
        },
      },
    },
  },
};

const RANK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ranked"],
  properties: {
    ranked: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "rank",
          "title",
          "severity",
          "file",
          "why_real",
          "fix_sketch",
          "suggested_check",
          "confidence",
        ],
        properties: {
          rank: { type: "number" },
          title: { type: "string" },
          severity: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
          file: { type: "string" },
          why_real: { type: "string" },
          fix_sketch: { type: "string" },
          suggested_check: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          dropped_reason: {
            type: "string",
            description: "if this was merged/dropped vs another, why (else empty)",
          },
        },
      },
    },
    notes: { type: "string" },
  },
};

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "files", "check_command", "spec"],
  properties: {
    summary: { type: "string" },
    files: { type: "string", description: "newline list of files expected to change" },
    check_command: {
      type: "string",
      description: "the single shell command that gates green (test slice + typecheck)",
    },
    spec: {
      type: "string",
      description:
        "the full phased TDD fix spec handed verbatim to the implement dispatch: test-first, the fix, scope guard, neutral commit",
    },
  },
};

// ============================ DISCOVER / SEED ============================
let ranked;
let top;
if (seedMode) {
  phase("Seed");
  ranked = seedCandidates.map((c, i) => ({
    rank: c.rank || i + 1,
    title: c.title || c.id || "seeded candidate",
    severity: c.severity || "MEDIUM",
    file: c.refined_file || c.file || "",
    why_real: c.why_real || c.reasoning || c.claim || "",
    fix_sketch: c.fix_sketch || c.refined_fix || "",
    suggested_check: c.suggested_check || "",
    confidence: c.confidence || "high",
  }));
  top = ranked[0];
  log(
    `Seed: ${ranked.length} pre-verified candidate(s); top [${top.severity}/${top.confidence}] ${top.title} (${top.file})`,
  );
} else {
  phase("Discover");

  const LENSES = [
    {
      key: "concurrency",
      focus:
        "concurrency & transactions: TOCTOU races, a CAS that is not actually atomic, partial commits where a paired write can fail independently, transaction boundaries that do not wrap all the mutations they claim, double-execution windows, lost updates, sweeper/recovery logic that can double-process or strand a row mid-flight, an unbounded side effect that can outlive a stale/requeue horizon.",
    },
    {
      key: "security",
      focus:
        'security & fail-closed posture: path traversal / input validation escapes, a "fail-closed" guard with a fail-open default or that strips-instead-of-rejects, validation that runs on one write path but not a sibling, an allowlist gap, a reject bypassable by casing/aliasing, a guard that logs-and-continues instead of rejecting, an unsafe default.',
    },
    {
      key: "correctness",
      focus:
        "correctness & boundaries: off-by-one / inclusive-exclusive window errors, a timeout that leaks a handle/timer or races the success path, reading the wrong source of truth, a resource leak, a swallowed error that hides a failure, an invariant a caller can violate, a migration/data path that can half-apply.",
    },
  ];

  const finderResults = await parallel(
    LENSES.map(
      (lens) => () =>
        agent(
          [
            `You are a code-defect finder sweeping the penumbra repo (your cwd is ${REPO}). Find the NEXT real, evidence-backed bug or correctness/security defect.`,
            ``,
            `SCOPE: ${scope}`,
            `EXCLUDE (do not report defects in): ${exclude}`,
            `YOUR LENS: ${lens.focus}`,
            ``,
            `Use git/grep/read to inspect the real code. Every candidate MUST cite file:line and the actual code, and 'why_real' MUST give a concrete input or call-sequence that yields the wrong outcome. 'suggested_check' must be a shell command (a focused test slice and/or typecheck) that a fix could be gated on.`,
            `Do NOT report style nits, hypotheticals you cannot ground, or anything an existing guard already prevents (re-read callers before claiming a gap). A short list of REAL findings beats a long speculative one. If the scope is clean for your lens, return {"candidates": []}.`,
          ].join("\n"),
          {
            label: `find:${lens.key}`,
            phase: "Discover",
            schema: CANDIDATES_SCHEMA,
            model: finderModel,
          },
        ),
    ),
  );

  const liveFinders = finderResults.filter(Boolean);
  const droppedFinders = LENSES.length - liveFinders.length;
  const rawCandidates = liveFinders.flatMap((r) => (r.candidates || []).map((c) => ({ ...c })));

  log(
    `Discover: ${rawCandidates.length} raw candidates across ${liveFinders.length}/${LENSES.length} live lenses` +
      (droppedFinders ? `, ${droppedFinders} finder(s) FAILED (e.g. transient API error)` : "") +
      ".",
  );

  if (!rawCandidates.length) {
    // Distinguish a genuine clean sweep from finders that never ran: reporting CLEAN when
    // every finder died (e.g. a 529 overload) is a false negative — discovery never happened.
    if (droppedFinders === LENSES.length) {
      return {
        ok: false,
        stage: "discover",
        dropped_finders: droppedFinders,
        verdict:
          "DEGRADED — every finder failed, so NO discovery was performed (likely a transient API error). This is NOT a clean result.",
        next: "re-run the workflow once the provider recovers; if it persists, check provider status.",
        scope,
        exclude,
      };
    }
    return {
      ok: true,
      stage: "discover",
      candidates: [],
      dropped_finders: droppedFinders,
      verdict: droppedFinders
        ? `CLEAN across ${liveFinders.length}/${LENSES.length} lenses — but ${droppedFinders} finder(s) failed, so coverage is PARTIAL; re-run for the missing lens(es).`
        : "CLEAN — no candidates surfaced in scope.",
      scope,
      exclude,
    };
  }

  // Rank + dedupe (one agent, sees all candidates — a genuine cross-item synthesis, so a barrier is correct here).
  const ranking = await agent(
    [
      `You are ranking candidate defects from a multi-lens sweep of the penumbra repo (cwd ${REPO}). Dedupe (merge same-root/same-file:line), drop anything an existing guard already prevents (verify against the code), and rank worst-first by (severity, then blast radius, then confidence). Keep at most ${candidateCount}.`,
      `For each kept candidate, set confidence by how concretely 'why_real' is grounded in code you can re-verify. Put a one-line dropped_reason on anything you merged away (omit otherwise).`,
      ``,
      `CANDIDATES (JSON):`,
      JSON.stringify(rawCandidates, null, 2),
    ].join("\n"),
    { label: "rank", phase: "Discover", schema: RANK_SCHEMA, model: plannerModel },
  );

  const rk = (ranking && ranking.ranked) || [];
  if (!rk.length) {
    return {
      ok: true,
      stage: "discover",
      candidates: rawCandidates,
      verdict: "CLEAN after ranking — all candidates deduped/dropped.",
      notes: ranking && ranking.notes,
    };
  }
  ranked = rk;
  top = rk[0];
  log(`Discover: top candidate [${top.severity}/${top.confidence}] ${top.title} (${top.file})`);
}

// ============================ PLAN ============================
phase("Plan");

const plan = await agent(
  [
    `You are planning a tight, test-first fix for ONE confirmed defect in the penumbra repo (cwd ${REPO}). Produce a phased TDD fix spec that a single fleet agent can execute in one branch.`,
    ``,
    `DEFECT:`,
    JSON.stringify(top, null, 2),
    ``,
    `Read the cited code first to ground the plan. The 'spec' you return is handed VERBATIM to the implementing agent, so it must be self-contained and include:`,
    `- the root cause (file:line) and the concrete failure it produces;`,
    `- TEST-FIRST: the new/changed test that must go RED before the fix and GREEN after (and would go RED again if the fix were reverted);`,
    `- the minimal fix, fail-safe by construction, with a tight scope guard (which files may change; do NOT touch unrelated behavior or pre-existing tests);`,
    `- "commit on the branch ALREADY checked out in your worktree; do NOT create, switch, or name a NEW branch — the fleet already isolated you on your own branch, and a new branch strands the work where landing cannot find it. Use a NEUTRAL message (no AI/assistant/co-authored attribution). Do NOT land/push/merge."`,
    `'check_command' is the SINGLE shell command that gates green. It MUST use only commands that already work in this repo — do NOT invent scripts or flags (a malformed check wastes every fix round):`,
    `  - tests: \`bun test <path/to/test.ts>\` with the DEFAULT reporter. Do NOT pass --reporter=spec (bun supports only junit/dots, so omit --reporter entirely).`,
    `  - typecheck: \`bun run typecheck\` (the existing root script). Do NOT use \`tsc --build ... --noEmit\` (contradictory flags) or \`bun run --cwd <pkg> typecheck\` (per-package scripts may not exist).`,
    `  Combine with && and keep it fast and specific (a focused test slice), e.g. "bun test packages/foo/test/bar.test.ts && bun run typecheck" — not the whole suite.`,
  ].join("\n"),
  { label: "plan", phase: "Plan", schema: PLAN_SCHEMA, model: plannerModel },
);
log(`Plan: ${plan.summary}`);
log(`Plan check: ${plan.check_command}`);

if (dryRunPlan) {
  return {
    ok: true,
    stage: "plan",
    dryRun: true,
    candidate: top,
    ranked,
    plan,
    scope,
    exclude,
    next: "dryRunPlan set — inspect the plan, then re-run without dryRunPlan to implement+review.",
  };
}

// ============================ IMPLEMENT + FIX-UNTIL-GREEN (inlined over penumbra-fanout) ============================
phase("Implement");

const implBase = [
  plan.spec,
  ``,
  `Scope guard — expected files: ${plan.files}`,
  `Work TEST-FIRST. Keep the change minimal and strictly in scope.`,
].join("\n");

function implMessage(roundIndex, prevBranch, prevOutput) {
  const head =
    roundIndex === 0
      ? implBase
      : `A previous attempt (branch ${prevBranch}) still fails the check. Build on that branch and fix it.\n\nOriginal task:\n${implBase}\n\nLast check output:\n${prevOutput || "(none captured)"}`;
  return [
    head,
    ``,
    `When done, run this check in the repo:`,
    `    ${plan.check_command}`,
    `If it fails, fix and re-run until it passes or you cannot make further progress. Commit your work on the worktree branch.`,
    "IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. If FAIL, follow it with the last ~50 lines of the check output inside a fenced ``` block.",
  ].join("\n");
}

const fixRounds = [];
let prevBranch = null;
let prevOutput = null;
let greenBranch = null;
let green = false;
let roundsUsed = 0;

for (let i = 0; i < maxFixRounds; i++) {
  roundsUsed = i + 1;
  const t = {
    label: `impl#${i + 1}:${fixAgent}`,
    initial_agent: fixAgent,
    task_class: "STANDARD",
    task_type: "implement_small",
    message: implMessage(i, prevBranch, prevOutput),
  };
  if (i === 0) {
    if (base && base !== "main") t.branch_base = base;
  } else {
    t.branch_base = prevBranch;
  }

  const fan = await workflow(
    { scriptPath: ".claude/workflows/penumbra-fanout.js" },
    { tasks: [t], dispatcherModel },
  );
  const r = ((fan && fan.results) || [])[0];
  if (!r || !r.ok || !r.branch) {
    fixRounds.push({ round: i + 1, dispatch_ok: false, result: r || null });
    log(`Implement round ${i + 1}: dispatch failed; stopping.`);
    break;
  }
  prevBranch = r.branch;
  const firstLine =
    String(r.response || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "";
  const passed = /^CHECK_RESULT:\s*PASS\b/i.test(firstLine);
  prevOutput = passed ? "" : String(r.response || "").slice(-4000);
  fixRounds.push({ round: i + 1, branch: r.branch, handoff_id: r.handoff_id, passed });
  log(`Implement round ${i + 1}: ${passed ? "PASS" : "FAIL"} on ${r.branch}`);
  if (passed) {
    green = true;
    greenBranch = r.branch;
    break;
  }
}

if (!green) {
  return {
    ok: false,
    stage: "implement",
    candidate: top,
    ranked,
    plan,
    fix_until_green: {
      green,
      final_branch: prevBranch,
      rounds_used: roundsUsed,
      rounds: fixRounds,
      check: plan.check_command,
    },
    verdict: prevBranch
      ? `Check never went green after ${roundsUsed} round(s); branch ${prevBranch} is NOT landable.`
      : "NO BRANCH — implement produced no branch.",
    next: "Inspect fix_until_green.rounds; refine the plan or re-dispatch manually. Nothing reviewed or landed.",
  };
}
log(`Implement: green on ${greenBranch} after ${roundsUsed} round(s).`);

// ============================ REVIEW (daemon multi-persona + optional HIGH fix-round) ============================
phase("Review");

const review = await workflow(
  { scriptPath: ".claude/workflows/adversarial-review.js" },
  {
    target_ref: greenBranch,
    base_ref: base,
    fixRound: true,
    fixAgent,
    ...(graderModel ? { graderModel } : {}),
    taskIntent: `Implement the planned fix for "${top.title}" (${top.file}) and keep the check (${plan.check_command}) green; address only HIGH review findings without reverting or weakening unrelated behavior.`,
  },
);

const highCount = (review && review.high_count) || 0;
const landCandidate = (review && review.land_candidate) || greenBranch;
const reviewVerdict = (review && review.verdict) || "unknown";
const fixRejected = !!(review && review.fix_rejected);
// The daemon adversarial-review can return 0 completed personas (unavailable / transient):
// high_count is then 0 not because the branch is clean but because nothing reviewed it.
// Treat that as NOT clean — the review must have actually run.
const reviewPersonas =
  review && Array.isArray(review.completed_personas) ? review.completed_personas.length : 0;
const reviewRan = reviewPersonas > 0;
const reviewComplete = review
  ? review.outcome !== "failed" &&
    ((review.failed_personas && review.failed_personas.length) || 0) === 0
  : false;

log(
  `Review: verdict="${reviewVerdict}" high=${highCount} personas=${reviewPersonas} land_candidate=${landCandidate} fix_rejected=${fixRejected}`,
);

const clean = green && highCount === 0 && !fixRejected && reviewRan && reviewComplete;

return {
  ok: true,
  scope,
  exclude,
  candidate: top,
  ranked,
  plan,
  fix_until_green: {
    green,
    final_branch: greenBranch,
    rounds_used: roundsUsed,
    rounds: fixRounds,
    check: plan.check_command,
  },
  review: {
    outcome: review && review.outcome,
    failed_personas: review && review.failed_personas,
    review_complete: reviewComplete,
    verdict: reviewVerdict,
    ran: reviewRan,
    completed_personas: reviewPersonas,
    high_count: highCount,
    medium_count: (review && review.medium_count) || 0,
    low_count: (review && review.low_count) || 0,
    fix_round_status: review && review.fix_round_status,
    land_candidate: landCandidate,
    land_candidate_reason: review && review.land_candidate_reason,
  },
  green_for_land: clean,
  land_candidate: landCandidate,
  next: clean
    ? `CLEAN: check green + review ran (${reviewPersonas} personas) + 0 HIGH findings. Maestro: run the authoritative land-check on ${landCandidate} (sibling-worktree/own-install if cross-package), then dispatch_land -> verify HEAD+content in main -> push -> teardown.`
    : !reviewRan
      ? `Check is green but the daemon adversarial-review did NOT run (0 personas) — the branch is UNREVIEWED. Maestro must review ${landCandidate} manually (or re-run the review) before landing; do NOT treat high_count=0 as clean.`
      : !reviewComplete
        ? `Check is green but the daemon adversarial-review was only PARTIALLY-REVIEWED (missing lenses: ${((review && review.failed_personas) || []).join(",") || "unknown"}). Maestro must review ${landCandidate} manually for the missing lenses (or re-run the review) before landing; do NOT treat high_count=0 as clean.`
        : fixRejected
          ? `Review fix-round was rejected by the independent grader; land candidate stays the pre-review branch ${landCandidate}. Maestro decides.`
          : `${highCount} HIGH finding(s) remain after the review fix-round (2-round cap). Maestro: lane_close review_debt, or run another targeted fix round before landing.`,
};
