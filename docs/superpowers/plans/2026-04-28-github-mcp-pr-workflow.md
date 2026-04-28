# GitHub MCP — PR-Based Auto-Merge Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace today's "worktree branch → FF-only merge to main" reconciler workflow with "worktree branch → push → open GitHub PR with rich context → maestro reviews + merges". This adds a real audit trail, gives reviewers (heavyweight agents or human) full diff context, and decouples the reconciler from local merge state contention (which has caused 4 of 4 dispatches today to need maestro cherry-pick).

**Why:** Today's flow has three structural problems:
1. **No audit trail beyond local git log** — abandoned branches in `/Volumes/WorkSSD/repos/penumbra-worktrees/` clutter local state with no provenance trail.
2. **Reconciler runs `bun test` (full suite) and refuses merge on any failure** — fragile gate; broken tests in package A block merges of work in package B (root cause of today's auto-merge gap).
3. **No review step** — the only quality gate is "tests passed". A reviewer agent looking at the diff before merge would catch logic bugs the test suite misses (the kind of bug that ends up in code review NITs).

PR-based workflow fixes all three: GitHub holds the audit trail, the PR carries test results AND diff context for review, the reviewer (agent or human) is the merge gate.

**Architecture:**
- Reconciler still runs typecheck + scoped tests (after the reconciler-scoped-tests plan ships) but on PASS, instead of FF-merge: pushes the worktree branch to GitHub and opens a PR via the github-mcp tool.
- PR description carries: dispatch handoff_id, prompt summary, agent name, test results, diff stats, reconciler outcome.
- Maestro (or a configured review agent) reviews the PR and either merges or closes-with-feedback.
- Auto-merge gate: optionally enable GitHub's auto-merge feature so PRs land when all required checks pass — let the reviewer just "approve" instead of click "merge".

**Tech Stack:** TypeScript, github-mcp (Anthropic-published `@modelcontextprotocol/server-github`), `gh` CLI as fallback / for ops the MCP doesn't cover, GitHub PAT or fine-scoped App.

---

## File Structure

| Action | Path | Reason |
|---|---|---|
| Modify | `~/.config/agentchat/agentchat.yaml` (NOT git-tracked) | Add `github` MCP server to relevant agents (at minimum a new `pr-reviewer` agent that has only github + penumbra MCPs). |
| Modify | `packages/agentchat/src/worker/merge-reconciler.ts` | Replace the `globalMergeLock.withLock(...)` block (the ff-merge / rebase block) with: push branch + open PR. Adds `getHandoff` to `ReconcilerDeps`. New `MergeResult` status `pr_opened`. |
| **Modify (REQUIRED)** | `packages/core/src/schemas/sse-events.ts` | The `MergeResultEventSchema` declares `status` as a strict `z.enum([...])`. Adding `pr_opened` requires editing the enum AND adding optional `pr_url: z.string().optional()` + `pr_number: z.number().optional()` fields. Hard prerequisite — Task 3 won't typecheck without it. |
| Modify | `packages/agentchat/bin/agentchat-worker.ts` | Optional: pass GitHub repo metadata (owner, repo) into the reconciler from env or config. |
| Create | `packages/agentchat/src/worker/github-pr-helper.ts` | Pure helper: `createPenumbraDispatchPR({ branch, handoffId, dispatchPrompt, testSummary, ... }) -> PullRequest`. Wraps github-mcp via the MCP client OR `gh` CLI. |
| Modify | `packages/agentchat/test/worker/merge-reconciler.test.ts` | Update for new `pr_opened` status path; add tests for `github-pr-helper`. |
| Create | `docs/superpowers/notes/2026-04-28-github-mcp-setup.md` | Operator setup recipe — PAT scope, env var name, repo config. |

---

## Pre-flight decisions before writing code

These decisions need consensus before Task 1 starts; surface them at audit time.

1. **Auth model**: GitHub Personal Access Token (PAT) vs GitHub App? And HOW does `gh` CLI see it?
   - **PAT** (v1): simpler, faster setup, scoped to user account, easy local dev.
   - **GitHub App** (later): cleaner audit trail, revocable, harder to set up.
   - **gh CLI auth**: `gh` only reads `GH_TOKEN` / `GITHUB_TOKEN` env vars OR its own keyring (`gh auth login`). It does NOT read arbitrary env vars like `PENUMBRA_GITHUB_TOKEN`.
   - **Recommendation**: use `gh auth login` (interactive, one-time per machine) — Task 1's operator setup handles this. The reconciler then doesn't need to touch env vars at all; `gh` reads the keyring. This avoids env-var rename gymnastics.
   - **Alternative (CI/non-interactive)**: spawn `gh` with `env: { ...process.env, GH_TOKEN: process.env.PENUMBRA_GITHUB_TOKEN ?? '' }` so the rename happens at spawn time. Document this clearly in Task 2 if that path is chosen.

2. **Repo discovery**: how does the reconciler know `owner/repo`?
   - **Option A**: parse `git remote get-url origin` in the worktree.
   - **Option B**: env var `PENUMBRA_GITHUB_REPO=acordeiro/penumbra`.
   - **Option C**: per-agent yaml field.
   - **Recommendation**: Option A (auto-discover) with B as override.

3. **PR target branch**: always `main`?
   - **Recommendation**: yes, always `main` for v1. Configurable via `PENUMBRA_PR_BASE` env if needed later.

4. **PR title format**:
   ```
   [<agent-name>] <first-line-of-prompt-summary>
   ```
   - Example: `[codex-mini] feat(agentchat): rebuild opencode-acp test mocks`

5. **PR body template**:
   ```
   ## Dispatched
   - **agent:** {{agentName}}
   - **handoff:** {{handoffId}}
   - **conversation:** {{conversationId}}

   ## Prompt
   <details><summary>Click to expand ({{promptLineCount}} lines)</summary>

   {{prompt}}
   </details>

   ## Reconciler results
   - typecheck: {{typecheckStatus}}
   - tests: {{testCommand}} → {{testCounts}}

   ## Diff
   {{filesChangedCount}} files, +{{additions}}/-{{deletions}}

   ---
   🤖 Auto-generated by penumbra reconciler
   ```

6. **Auto-merge enablement**: should the reconciler enable GitHub's "auto-merge" toggle on the PR?
   - **Recommendation**: yes, IF (a) the repo has Settings → General → Pull Requests → **"Allow auto-merge" enabled** AND (b) branch protection requires at least one check OR review. Both conditions are required for `gh pr merge --auto` to succeed.
   - Configurable via `PENUMBRA_PR_AUTO_MERGE` (default true).
   - Operator setup (Task 1) MUST document the repo-level "Allow auto-merge" toggle.

7. **Behavior when reconciler tests/typecheck FAIL**: open a PR as draft, or skip PR entirely?
   - **v1 recommendation: skip PR creation on failure.** The reconciler returns `test_failed` / `typecheck_failed` (existing variants); maestro inspects the worktree and decides what to do. This keeps Task 3 small and avoids the "draft PR variant declared but never produced" footgun.
   - The `pr_opened_as_draft` variant is **NOT in v1.** Defer to a follow-up plan once the happy-path PR flow is proven. v2 can revisit if operators ask for failure-as-draft-PR.

---

## Task 1: Operator setup recipe (MAESTRO-SIDE, before any code)

**Files:**
- Create: `docs/superpowers/notes/2026-04-28-github-mcp-setup.md`

Documents (in this order):
1. **`gh auth login`** — interactive one-time auth. Stores the token in macOS Keychain via `gh`'s keyring. The reconciler invokes `gh` directly; no env vars needed.
2. (Alternative for non-interactive setup) Set `GH_TOKEN=ghp_xxx` in the worker's environment.
3. **Repo-level toggle (REQUIRED for auto-merge)**: Settings → General → Pull Requests → enable "Allow auto-merge".
4. **Branch protection on `main`**: require 1 approval, require status checks to pass, allow squash-merge only.
5. Optional: `PENUMBRA_GITHUB_REPO=acordeiro/penumbra` if auto-discovery via `git remote get-url origin` doesn't work.
6. Smoke test command: `gh pr list -R <owner/repo>` should succeed without prompting for auth.
7. (For pr-reviewer agent yaml — Task 4) `@modelcontextprotocol/server-github` MCP package — agents need `GITHUB_PERSONAL_ACCESS_TOKEN` env, separate from the gh CLI's keyring.

This is operator-side; do it BEFORE the code work because the smoke test depends on it.

---

## Task 2: `github-pr-helper.ts` — pure PR-creation helper

**Files:**
- Create: `packages/agentchat/src/worker/github-pr-helper.ts`
- Create: `packages/agentchat/test/worker/github-pr-helper.test.ts`

Pure function with injected exec. No I/O dependencies in tests.

**Key design**: this helper does NOT use the github-mcp directly (the MCP is meant for agents to consume; the worker is a TS process, not an agent). Instead, the worker uses the `gh` CLI binary or `octokit` npm package for direct API calls. The github-mcp wires INTO PR REVIEW for reviewer agents, not into PR creation by the worker.

Wait — re-read the goal. The github-mcp is for the reviewer agent's flow. PR creation by the reconciler can use either:
- (a) `gh` CLI: simple, no auth complexity beyond `gh auth login`.
- (b) `octokit`: typed, requires installing the dep + handling auth.
- (c) github-mcp client (the worker spawns an MCP client to talk to its own MCP server): overkill for this.

**Recommendation**: use `gh` CLI for PR creation in the reconciler. Use github-mcp for the reviewer-agent's PR-review tools (read PR diff, comment, approve, merge).

- [ ] **Step 1: Probe gh CLI presence**

```bash
gh --version 2>&1 | head -1
```

Expected: `gh version 2.x...`. If not installed, document install in the operator setup doc.

- [ ] **Step 2: Write the failing test**

(Skipping the full test code here for plan brevity — implementer should write a TDD test against a mocked exec that returns canned `gh pr create` output and asserts the helper returns the parsed PR URL/number.)

- [ ] **Step 3: Implement the helper**

**SECURITY NOTE (defect 3 from pre-flight): NO heredoc, NO shell-string command.** A dispatch prompt that contains `$(...)` would execute as shell during PR creation, since the existing reconciler `runCommand` helper uses `spawn(..., { shell: true })`. Use `child_process.spawn` with array args (no shell) and write the body to a temp file passed via `--body-file`.

```ts
// packages/agentchat/src/worker/github-pr-helper.ts
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '@penumbra/core';

export interface CreatePRArgs {
  branch: string;          // e.g. agent/h-abc123
  baseBranch: string;      // 'main'
  title: string;
  body: string;
  draft: boolean;
  cwd: string;             // path to worktree (gh CLI runs there)
}

export interface CreatePRResult {
  url: string;
  number: number;
}

interface SpawnRunner {
  run: (
    file: string,
    args: string[],
    options: { cwd: string; env?: Record<string, string> },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

/** Default array-args spawn runner. No shell — eliminates injection risk. */
export const defaultSpawnRunner: SpawnRunner = {
  run: (file, args, options) =>
    new Promise((resolve, reject) => {
      const proc = spawn(file, args, { cwd: options.cwd, shell: false, env: options.env });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    }),
};

export async function createDispatchPR(
  args: CreatePRArgs,
  log: Logger,
  runner: SpawnRunner = defaultSpawnRunner,
): Promise<CreatePRResult> {
  // 1. Push branch (array args; the branch name is hyphen-uuid form, no shell metachars expected, but spawn is still safer).
  const push = await runner.run('git', ['push', '-u', 'origin', args.branch], { cwd: args.cwd });
  if (push.code !== 0) {
    throw new Error(`git push failed (${push.code}): ${push.stderr.slice(0, 500)}`);
  }

  // 2. Write body to a temp file. gh accepts --body-file <path>.
  const bodyFile = path.join(os.tmpdir(), `penumbra-pr-body-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  await fs.writeFile(bodyFile, args.body, 'utf8');

  try {
    // 3. Create PR via array args. NO shell. Title and body are passed as discrete argv elements.
    const ghArgs = [
      'pr', 'create',
      '--base', args.baseBranch,
      '--head', args.branch,
      '--title', args.title,
      '--body-file', bodyFile,
    ];
    if (args.draft) ghArgs.push('--draft');

    const create = await runner.run('gh', ghArgs, { cwd: args.cwd });
    if (create.code !== 0) {
      throw new Error(`gh pr create failed (${create.code}): ${create.stderr.slice(0, 500)}`);
    }

    const url = create.stdout.trim();
    const numberMatch = url.match(/\/pull\/(\d+)/);
    if (!numberMatch) {
      log.error({ url, stderr: create.stderr }, 'failed to parse PR number from gh output');
      throw new Error(`gh pr create returned unparseable output: ${url}`);
    }
    return { url, number: Number(numberMatch[1]) };
  } finally {
    await fs.rm(bodyFile, { force: true }).catch(() => {});
  }
}
```

Tests inject a mock `SpawnRunner` to assert: (a) `git push` runs first with the expected branch arg; (b) the body file is created with the expected content; (c) `gh pr create` runs with `--body-file <path>` and the file's content matches; (d) the body file is cleaned up even when gh errors; (e) malicious title `$(touch /tmp/pwned)` is passed as a literal argv element and never executed.

- [ ] **Step 4: Tests pass + commit.**

---

## Task 3: Reconciler integration — replace FF-merge with PR creation

**Files:**
- Modify: `packages/agentchat/src/worker/merge-reconciler.ts`
- Modify: `packages/agentchat/test/worker/merge-reconciler.test.ts`
- Modify: `packages/agentchat/bin/agentchat-worker.ts` (thread `getHandoff` into ReconcilerDeps)

### Pre-task: extend ReconcilerDeps with `getHandoff`

The current `ReconcilerDeps` (around `merge-reconciler.ts:69-75`) has `worktreeManager`, `postProgress`, `log`, `mainRepoDir`, `exec`. The PR body needs handoff metadata (agent name, prompt, conversation_id). Add:

```ts
export interface ReconcilerDeps {
  // ... existing fields ...
  getHandoff: (handoffId: string) => Promise<HandoffRow | null>;
}
```

In `agentchat-worker.ts` where the reconciler is constructed, wire it:

```ts
const reconcileWorktree = createMergeReconciler({
  // ... existing fields ...
  getHandoff: async (id) => {
    try {
      const { handoff } = await client.getHandoff(id);
      return handoff;
    } catch (err) {
      // 404 / not found → null; let the reconciler decide what to do.
      return null;
    }
  },
});
```

(The existing `client.getHandoff` returns `{ handoff }`; unwrap it.)

### Replace the `globalMergeLock.withLock(...)` block

Locate the `globalMergeLock.withLock(async () => { ... })` call (the FF-merge / rebase block — line numbers shifted post reconciler-scoped, but the block is unambiguous by structure). Replace its body with:

```ts
// 4. Push branch and open PR (replaces ff-merge / rebase)
try {
  const handoff = await deps.getHandoff(handoffId);
  const dispatchPrompt = handoff?.message ?? '<unknown>';
  const agentName = handoff?.to_agent ?? '<unknown>';
  const conversationId = handoff?.conversation_id ?? null;

  const diffStats = await runCmd(`git diff main...${wt.branchName} --shortstat`, wt.path);

  const prResult = await createDispatchPR({
    branch: wt.branchName,
    baseBranch: 'main',
    title: `[${agentName}] ${dispatchPrompt.split('\n')[0].slice(0, 60)}`,
    body: renderPRBody({
      agentName, handoffId, conversationId,
      dispatchPrompt, typecheckStatus: 'pass', testCommand: testCommandUsed, testSummary: 'pass',
      diffStats: diffStats.stdout,
    }),
    draft: false,
    cwd: wt.path,
  }, deps.log);

  const result: MergeResult = {
    status: 'pr_opened',
    pr_url: prResult.url,
    pr_number: prResult.number,
  };
  await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
  return result;
} catch (err: any) {
  deps.log.error({ handoffId, err: String(err) }, 'PR creation failed');
  const result: MergeResult = { status: 'pr_creation_failed', regression_summary: String(err) };
  await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
  return result;
}
```

**Required new `MergeResult` variants (v1):**
- `pr_opened` — happy path; carries `pr_url: string` + `pr_number: number`
- `pr_creation_failed` — push, gh, or PR-create failed; carries `regression_summary` like other failure variants.

**`pr_opened_as_draft` is NOT in v1.** Failure paths (typecheck_failed, test_failed) keep their current early-return behavior — no PR created. Operator can manually push if the worktree's diff is worth reviewing. (Defer the failure-as-draft-PR variant to a follow-up plan.)

### Schema bump (Task 3 Step 0 — REQUIRED, before any code in Task 3)

In `packages/core/src/schemas/sse-events.ts`, locate `MergeResultEventSchema`. Add the new status to the enum and add the optional PR fields:

```ts
export const MergeResultEventSchema = z.object({
  type: z.literal('merge-result'),
  handoff_id: z.string(),
  status: z.enum([
    'merged',
    'rebased',
    'rebase_conflict',
    'test_failed',
    'typecheck_failed',
    // ↓ NEW for github-mcp PR workflow
    'pr_opened',
    'pr_creation_failed',
  ]),
  conflict_files: z.array(z.string()).optional(),
  regression_summary: z.string().optional(),
  timed_out: z.boolean().optional(),
  worktree_dirty: z.boolean().optional(),
  // ↓ NEW for pr_opened
  pr_url: z.string().optional(),
  pr_number: z.number().optional(),
});
```

Verify the field set matches whatever the schema currently has (other optional fields may be present); add the two new optional fields without disturbing existing ones. Commit this schema bump as its own Task 3 Step 0 commit BEFORE the reconciler code change — keeps the diff reviewable.

- [ ] Tasks broken out: schema bump → helper integration → reconciler integration → smoke.

---

## Task 4: Reviewer agent yaml entry (MAESTRO-SIDE)

Add a new agent to `~/.config/agentchat/agentchat.yaml` whose role is "review the PR the reconciler just opened":

```yaml
  - name: pr-reviewer
    adapter: stdio-acp  # or opencode-cli; pick the trusted heavyweight tier
    description: "Reviews penumbra dispatch PRs. Reads the PR diff via github-mcp, validates against the dispatch's prompt, comments + approves/closes."
    options:
      binary: claude-agent-acp  # or whichever
      mcpServers:
        - name: penumbra
          command: bun
          args: [/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts]
          env: [{ name: PENUMBRA_STORAGE_ROOT, value: /tmp/penumbra-live }]
        - name: github
          command: npx
          args: ["-y", "@modelcontextprotocol/server-github"]
          env: [{ name: GITHUB_PERSONAL_ACCESS_TOKEN, value: <env:PENUMBRA_GITHUB_TOKEN> }]
      fsReadTextFile: true
    roles: []
```

Maestro can dispatch this agent against any PR with: `chain.start({ initial_agent: 'pr-reviewer', message: 'Review PR #N' })`.

---

## Task 5: Smoke test (MAESTRO-SIDE)

End-to-end:
1. Dispatch any small change (e.g., docs edit) to codex-mini.
2. Wait for reconciler to open PR.
3. Verify PR exists in GitHub UI with correct body.
4. Dispatch pr-reviewer against the PR number.
5. Verify pr-reviewer comments + approves OR rejects with reasoning.
6. Manually merge if approved.

---

## Verification — does the plan cover the spec?

| Goal | Task |
|---|---|
| Replace FF-merge with PR creation | Task 3 |
| Rich PR body with dispatch context | Task 2 (renderPRBody) |
| github-mcp wired for reviewer agents | Task 4 |
| Operator setup documented | Task 1 |
| Smoke validates end-to-end | Task 5 |

## Risks & open questions

1. **GitHub rate limits** — for solo-account PAT, 5000 req/hour. Likely fine for low dispatch volume; would hit limits at high volume (>50 dispatches/hour). Document; add Phase 5 task to migrate to App if hit.
2. **Branch cleanup** — old worktree branches will accumulate on GitHub. Add a periodic cleanup task (delete branches whose PRs are closed for >7 days).
3. **Repo permissions** — the maestro account needs write access to the repo for the PAT to work. For team setups, document the minimum-scope permissions.
4. **Cherry-pick fallback** — when github-mcp is unavailable (network down, token expired), the reconciler should fall back to ff-merge. Add a feature flag `PENUMBRA_USE_PR_WORKFLOW` (default false initially, true after this plan ships).

## Estimated effort

- Task 1 (operator setup): 30 min
- Task 2 (helper + tests): 1.5 hours
- Task 3 (reconciler integration): 2 hours
- Task 4 (reviewer agent yaml + smoke wiring): 30 min
- Task 5 (smoke): 30 min

Total: ~5 hours focused work. Could split: helper + reconciler in one dispatch (~3.5 hours impl), reviewer wiring in a follow-up.
