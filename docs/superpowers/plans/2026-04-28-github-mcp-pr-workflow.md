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
| Modify | `packages/agentchat/src/worker/merge-reconciler.ts` | Replace ff-merge / rebase block with: push branch + open PR. New `MergeResult` status `pr_opened`. |
| Modify | `packages/agentchat/bin/agentchat-worker.ts` | Optional: pass GitHub repo metadata (owner, repo) into the reconciler from env or config. |
| Create | `packages/agentchat/src/worker/github-pr-helper.ts` | Pure helper: `createPenumbraDispatchPR({ branch, handoffId, dispatchPrompt, testSummary, ... }) -> PullRequest`. Wraps github-mcp via the MCP client OR `gh` CLI. |
| Modify | `packages/agentchat/test/worker/merge-reconciler.test.ts` | Update for new `pr_opened` status path; add tests for `github-pr-helper`. |
| Create | `docs/superpowers/notes/2026-04-28-github-mcp-setup.md` | Operator setup recipe — PAT scope, env var name, repo config. |

---

## Pre-flight decisions before writing code

These decisions need consensus before Task 1 starts; surface them at audit time.

1. **Auth model**: GitHub Personal Access Token (PAT) vs GitHub App?
   - **PAT**: simpler, faster setup, scoped to user account, easy local dev.
   - **GitHub App**: cleaner audit trail (PRs come from "penumbra-bot"), revocable, can be scoped per-repo, harder to set up.
   - **Recommendation**: PAT for v1, document migration path to App.
   - Token env var: `PENUMBRA_GITHUB_TOKEN` (avoid generic GH_TOKEN to prevent collision with other tooling).

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
   - **Recommendation**: yes, IF the repo has branch protection requiring 1 approval. Otherwise the PR sits open until manually merged.
   - Configurable via `PENUMBRA_PR_AUTO_MERGE` (default true).

7. **Behavior when reconciler tests/typecheck FAIL**: still open a PR (as draft, with failure context) or skip PR entirely?
   - **Recommendation**: open as DRAFT PR with the failure summary. Lets the reviewer triage without losing the work. Maestro can convert draft → ready when fixed.

---

## Task 1: Operator setup recipe (MAESTRO-SIDE, before any code)

**Files:**
- Create: `docs/superpowers/notes/2026-04-28-github-mcp-setup.md`

Documents:
1. PAT creation steps (scope: `repo` + `workflow` for v1; narrow to App later).
2. Env var to set: `PENUMBRA_GITHUB_TOKEN=ghp_xxx`.
3. Optional: `PENUMBRA_GITHUB_REPO=acordeiro/penumbra` if auto-discovery doesn't work.
4. How to test: `npx -y @modelcontextprotocol/server-github` with the env var set.
5. Branch protection recommendation: require 1 approval on `main`, allow squash merge only.

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

```ts
// packages/agentchat/src/worker/github-pr-helper.ts
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

export async function createDispatchPR(
  args: CreatePRArgs,
  exec: (cmd: string, opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }>,
  log: Logger,
): Promise<CreatePRResult> {
  // Push first
  await exec(`git push -u origin "${args.branch}"`, { cwd: args.cwd });

  const draftFlag = args.draft ? ' --draft' : '';
  // Use heredoc to avoid quoting nightmares with multi-line body.
  // gh accepts --body-file -; pipe the body in via shell.
  const cmd = `gh pr create --base "${args.baseBranch}" --head "${args.branch}" --title ${JSON.stringify(args.title)} --body-file -${draftFlag} <<'PENUMBRA_BODY_EOF'\n${args.body}\nPENUMBRA_BODY_EOF`;
  const res = await exec(cmd, { cwd: args.cwd });

  // gh prints the PR URL on stdout; parse the number from the URL
  const url = res.stdout.trim();
  const numberMatch = url.match(/\/pull\/(\d+)/);
  if (!numberMatch) {
    log.error({ url, stderr: res.stderr }, 'failed to parse PR number from gh output');
    throw new Error(`gh pr create returned unparseable output: ${url}`);
  }
  return { url, number: Number(numberMatch[1]) };
}
```

- [ ] **Step 4: Tests pass + commit.**

---

## Task 3: Reconciler integration — replace FF-merge with PR creation

**Files:**
- Modify: `packages/agentchat/src/worker/merge-reconciler.ts`
- Modify: `packages/agentchat/test/worker/merge-reconciler.test.ts`

Replace the `globalMergeLock.withLock(async () => { ... ff merge ... rebase ... })` block (lines 205-265) with:

```ts
// 4. Push branch and open PR
try {
  const handoff = await deps.handoffReader.get(handoffId);
  const dispatchPrompt = handoff?.message ?? '<unknown>';
  const agentName = handoff?.to_agent ?? '<unknown>';
  const testSummary = `${testPasses} pass, ${testSkips} skip, ${testFails} fail`;
  const diffStats = await runCmd(`git diff main...${wt.branchName} --shortstat`, wt.path);

  const prResult = await createDispatchPR({
    branch: wt.branchName,
    baseBranch: 'main',
    title: `[${agentName}] ${dispatchPrompt.split('\n')[0].slice(0, 60)}`,
    body: renderPRBody({
      agentName, handoffId, conversationId: handoff?.conversation_id,
      dispatchPrompt, typecheckStatus: 'pass', testCommand, testSummary,
      diffStats: diffStats.stdout,
    }),
    draft: false,  // tests passed; ready for review
    cwd: wt.path,
  }, deps.exec ?? defaultExec, deps.log);

  const result: MergeResult = {
    status: 'pr_opened',
    pr_url: prResult.url,
    pr_number: prResult.number,
  };
  await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
  return result;
} catch (err: any) {
  // PR creation failed — fall back to opening a draft PR with failure context
  // OR (simpler v1) just log and let the operator manually push the branch
  deps.log.error({ handoffId, err: String(err) }, 'PR creation failed');
  return { status: 'pr_creation_failed', regression_summary: String(err) };
}
```

**Required new `MergeResult` variants:**
- `pr_opened` — happy path; carries pr_url + pr_number
- `pr_opened_as_draft` — typecheck or tests failed; PR was opened as draft for triage
- `pr_creation_failed` — couldn't even open a PR

The existing `merge-result` ConversationStreamEvent type may need a schema bump to accept these new variants — verify before writing.

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
