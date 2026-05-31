#!/usr/bin/env bash
# Regression suite for penumbra-agent-gc-guard.sh (plan P1 / B6).
# Plain-sh harness (no bats dependency). Each case builds a throwaway git repo,
# pipes a PreToolUse JSON payload to the guard, and asserts the exit code.
#
# Exit 0 = guard ALLOWS the command through; exit 2 = guard BLOCKS it.
#
# Run: bash ~/.claude/hooks/test/penumbra-agent-gc-guard.test.sh
# Env: GUARD=/path/to/guard.sh to override the hook under test.

set -uo pipefail

GUARD="${GUARD:-$HOME/.claude/hooks/penumbra-agent-gc-guard.sh}"
PASS=0
FAIL=0
UUID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

if [ ! -x "$GUARD" ]; then
  echo "FATAL: guard not executable at $GUARD" >&2
  exit 1
fi

# payload <command> <cwd>  -> emits the PreToolUse JSON the hook reads on stdin
payload() {
  # minimal JSON; the guard parses tool_input.command and cwd (jq or grep path)
  printf '{"tool_input":{"command":%s},"cwd":%s}' \
    "$(json_str "$1")" "$(json_str "$2")"
}
json_str() {
  # quote a string as a JSON scalar (escape backslash and double-quote)
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

# run_case <name> <expected_exit> <command> <cwd> [env_assignment]
run_case() {
  local name=$1 expected=$2 cmd=$3 cwd=$4 envassign=${5:-}
  local got
  if [ -n "$envassign" ]; then
    got=$(payload "$cmd" "$cwd" | env "$envassign" "$GUARD" >/dev/null 2>&1; echo $?)
  else
    got=$(payload "$cmd" "$cwd" | "$GUARD" >/dev/null 2>&1; echo $?)
  fi
  if [ "$got" = "$expected" ]; then
    echo "ok   - $name (exit $got)"
    PASS=$((PASS + 1))
  else
    echo "FAIL - $name (expected $expected, got $got)"
    FAIL=$((FAIL + 1))
  fi
}

# --- repo builders -----------------------------------------------------------

# A repo whose agent/<uuid> branch tip IS main (ancestor / ff case).
mk_repo_ancestor() {
  local d; d=$(mktemp -d)
  git -C "$d" init -q
  git -C "$d" config user.email t@t && git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m base
  git -C "$d" branch "agent/$UUID"
  printf '%s' "$d"
}

# A repo where the branch's own commit was squash-landed into main (different SHA,
# but `git diff branch main` is empty — content identical).
mk_repo_squashed() {
  local d; d=$(mktemp -d)
  git -C "$d" init -q
  git -C "$d" config user.email t@t && git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m base
  git -C "$d" branch "agent/$UUID"
  git -C "$d" -c advice.detachedHead=false checkout -q "agent/$UUID"
  printf 'x\n' > "$d/f.txt"; git -C "$d" add f.txt; git -C "$d" commit -q -m work
  git -C "$d" checkout -q master 2>/dev/null || git -C "$d" checkout -q main 2>/dev/null
  # squash the same content onto main
  printf 'x\n' > "$d/f.txt"; git -C "$d" add f.txt; git -C "$d" commit -q -m "squash of work"
  printf '%s' "$d"
}

# A repo where the branch's OWN file is in main, but main ALSO advanced past the
# branch's merge-base with an unrelated landed change (stale-base case).
mk_repo_stalebase() {
  local d; d=$(mktemp -d)
  git -C "$d" init -q
  git -C "$d" config user.email t@t && git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m base
  git -C "$d" branch "agent/$UUID"
  git -C "$d" -c advice.detachedHead=false checkout -q "agent/$UUID"
  printf 'own\n' > "$d/own.txt"; git -C "$d" add own.txt; git -C "$d" commit -q -m own-work
  git -C "$d" checkout -q master 2>/dev/null || git -C "$d" checkout -q main 2>/dev/null
  # land the branch's own file
  printf 'own\n' > "$d/own.txt"; git -C "$d" add own.txt; git -C "$d" commit -q -m "land own"
  # advance main further with an unrelated change (makes diff branch..main non-empty)
  printf 'other\n' > "$d/other.txt"; git -C "$d" add other.txt; git -C "$d" commit -q -m "unrelated landed"
  printf '%s' "$d"
}

# A repo where the branch has genuinely-unlanded content (own file NOT in main).
mk_repo_unlanded() {
  local d; d=$(mktemp -d)
  git -C "$d" init -q
  git -C "$d" config user.email t@t && git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m base
  git -C "$d" branch "agent/$UUID"
  git -C "$d" -c advice.detachedHead=false checkout -q "agent/$UUID"
  printf 'unlanded\n' > "$d/u.txt"; git -C "$d" add u.txt; git -C "$d" commit -q -m unlanded
  git -C "$d" checkout -q master 2>/dev/null || git -C "$d" checkout -q main 2>/dev/null
  printf '%s' "$d"
}

DEL="git branch -D agent/$UUID"

# --- characterization cases (current hook behavior) --------------------------

R=$(mk_repo_ancestor);  run_case "ancestor/ff branch -> ALLOW" 0 "$DEL" "$R"; rm -rf "$R"
R=$(mk_repo_squashed);  run_case "squash empty-diff -> ALLOW"  0 "$DEL" "$R"; rm -rf "$R"
R=$(mk_repo_stalebase); run_case "stale-base own-files-in-main -> ALLOW" 0 "$DEL" "$R"; rm -rf "$R"
R=$(mk_repo_unlanded);  run_case "genuinely unlanded -> BLOCK" 2 "$DEL" "$R"; rm -rf "$R"

# non-destructive command -> ALLOW
R=$(mk_repo_unlanded);  run_case "non-destructive (git status) -> ALLOW" 0 "git status" "$R"; rm -rf "$R"

# fail-open: branch absent (delete a uuid that doesn't exist) -> ALLOW
R=$(mk_repo_ancestor);  run_case "branch absent -> ALLOW (fail-open)" 0 "git branch -D agent/00000000-0000-0000-0000-000000000000" "$R"; rm -rf "$R"

# fail-open: not a git repo -> ALLOW
NOREPO=$(mktemp -d);    run_case "no git repo -> ALLOW (fail-open)" 0 "$DEL" "$NOREPO"; rm -rf "$NOREPO"

# worktree remove on an unlanded branch's worktree -> BLOCK (matcher covers it)
# (use the unlanded repo; the command references the agent uuid)
R=$(mk_repo_unlanded);  run_case "worktree remove unlanded -> BLOCK" 2 "git worktree remove --force /tmp/x/agent/$UUID" "$R"; rm -rf "$R"

# --- B5: broadened ref-deletion-intent matcher (these bypass git branch -D) ---
R=$(mk_repo_unlanded);  run_case "update-ref -d unlanded -> BLOCK" 2 "git update-ref -d refs/heads/agent/$UUID" "$R"; rm -rf "$R"
R=$(mk_repo_unlanded);  run_case "push colon-ref delete unlanded -> BLOCK" 2 "git push origin :agent/$UUID" "$R"; rm -rf "$R"
R=$(mk_repo_unlanded);  run_case "push --delete unlanded -> BLOCK" 2 "git push origin --delete agent/$UUID" "$R"; rm -rf "$R"
# B5 must NOT over-block: the same vectors on a SAFE (ancestor) branch -> ALLOW
R=$(mk_repo_ancestor);  run_case "update-ref -d ancestor -> ALLOW" 0 "git update-ref -d refs/heads/agent/$UUID" "$R"; rm -rf "$R"

# --- B4: override must be reachable WITHOUT relying on the hook's own env --------
# inline token in the command string (the form an operator actually types)
R=$(mk_repo_unlanded);  run_case "inline-token override unlanded -> ALLOW" 0 "PENUMBRA_ALLOW_AGENT_GC=1 git branch -D agent/$UUID" "$R"; rm -rf "$R"
# sentinel file present (path injected via env, which IS reachable by the hook in test)
R=$(mk_repo_unlanded); SENT=$(mktemp); \
  run_case "sentinel-file override unlanded -> ALLOW" 0 "$DEL" "$R" "PENUMBRA_ALLOW_AGENT_GC_SENTINEL=$SENT"; \
  rm -f "$SENT"; rm -rf "$R"
# sentinel path set but file ABSENT -> unlanded still BLOCKS
R=$(mk_repo_unlanded);  run_case "sentinel path set but absent -> BLOCK" 2 "$DEL" "$R" "PENUMBRA_ALLOW_AGENT_GC_SENTINEL=/tmp/nonexistent-penumbra-sentinel-$$"; rm -rf "$R"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
