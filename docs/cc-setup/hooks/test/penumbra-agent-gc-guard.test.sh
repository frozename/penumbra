#!/usr/bin/env bash
# Regression suite for penumbra-agent-gc-guard.sh (plan P1 / B6).
# Plain-sh harness (no bats dependency). Each case builds a throwaway git repo,
# pipes a PreToolUse JSON payload to the guard, and asserts the exit code.
#
# Exit 0 = guard ALLOWS the command through; exit 2 = guard BLOCKS it.
#
# Run: bash docs/cc-setup/hooks/test/penumbra-agent-gc-guard.test.sh
# Env: GUARD=/path/to/guard.sh to override the hook under test.

set -uo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 1
GUARD="${GUARD:-$SCRIPT_DIR/../penumbra-agent-gc-guard.sh}"
PASS=0
FAIL=0
UUID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
DBMEMBER_BRANCH="feat/foo"

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

long_benign_command() {
  local prefix=$1 width=${2:-0} cmd=$1 fill="" i=1
  while [ "$i" -le "$width" ]; do
    fill="${fill}x"
    i=$((i + 1))
  done
  i=1
  while [ "$i" -le 400 ]; do
    cmd="$cmd ${fill}token$i"
    i=$((i + 1))
  done
  printf '%s' "$cmd"
}

run_timing_case() {
  local name=$1 cmd=$2 cwd=$3 max_seconds=$4
  local result status got elapsed payload_file
  payload_file=$(mktemp)
  payload "$cmd" "$cwd" > "$payload_file"
  result=$(python3 - "$GUARD" "$payload_file" "$max_seconds" <<'PY'
import subprocess
import sys
import time

guard = sys.argv[1]
payload_path = sys.argv[2]
max_seconds = float(sys.argv[3])

with open(payload_path, "rb") as f:
    payload = f.read()

start = time.time()
completed = subprocess.run(
    [guard],
    input=payload,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
elapsed = time.time() - start
print(f"{completed.returncode} {elapsed:.6f}")
sys.exit(0 if completed.returncode == 0 and elapsed < max_seconds else 1)
PY
  )
  status=$?
  rm -f "$payload_file"
  got=${result%% *}
  elapsed=${result#* }
  if [ "$status" = 0 ]; then
    echo "ok   - $name (exit $got, ${elapsed}s)"
    PASS=$((PASS + 1))
  else
    echo "FAIL - $name (exit $got, ${elapsed}s, max ${max_seconds}s)"
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

mk_repo_unlanded_named() {
  local branch=$1
  local d; d=$(mktemp -d)
  git -C "$d" init -q
  git -C "$d" config user.email t@t && git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m base
  git -C "$d" checkout -q -b "$branch"
  printf 'unlanded\n' > "$d/u.txt"; git -C "$d" add u.txt; git -C "$d" commit -q -m unlanded
  git -C "$d" checkout -q master 2>/dev/null || git -C "$d" checkout -q main 2>/dev/null
  printf '%s' "$d"
}

mk_repo_ancestor_named() {
  local branch=$1
  local d; d=$(mktemp -d)
  git -C "$d" init -q
  git -C "$d" config user.email t@t && git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m base
  git -C "$d" branch "$branch"
  printf '%s' "$d"
}

mk_db_with_branch() {
  local branch=$1
  local db; db=$(mktemp)
  rm -f "$db"
  sqlite3 "$db" "CREATE TABLE handoffs(handoff_id TEXT, branch_name TEXT); INSERT INTO handoffs(handoff_id, branch_name) VALUES ('h1', '$branch');"
  printf '%s' "$db"
}

DEL="git branch -D agent/$UUID"

# --- characterization cases (current hook behavior) --------------------------

R=$(mk_repo_ancestor);  run_case "ancestor/ff branch -> ALLOW" 0 "$DEL" "$R"; rm -rf "$R"
R=$(mk_repo_squashed);  run_case "squash empty-diff -> ALLOW"  0 "$DEL" "$R"; rm -rf "$R"
R=$(mk_repo_stalebase); run_case "stale-base own-files-in-main -> ALLOW" 0 "$DEL" "$R"; rm -rf "$R"
R=$(mk_repo_unlanded);  run_case "genuinely unlanded -> BLOCK" 2 "$DEL" "$R"; rm -rf "$R"

R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member named branch unlanded -> BLOCK" 2 "git branch -D $DBMEMBER_BRANCH" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member named branch --delete unlanded -> BLOCK" 2 "git branch --delete $DBMEMBER_BRANCH" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member named branch --delete --force unlanded -> BLOCK" 2 "git branch --delete --force $DBMEMBER_BRANCH" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member named branch --force -d unlanded -> BLOCK" 2 "git branch --force -d $DBMEMBER_BRANCH" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member named branch -f -d unlanded -> BLOCK" 2 "git branch -f -d $DBMEMBER_BRANCH" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member named branch -r -d unlanded -> BLOCK" 2 "git branch -r -d $DBMEMBER_BRANCH" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_ancestor_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member named branch ancestor -> ALLOW" 0 "git branch -D $DBMEMBER_BRANCH" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); \
  run_case "non-member named branch unlanded -> ALLOW" 0 "git branch -D $DBMEMBER_BRANCH" "$R"; \
  rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); \
  run_case "non-member named branch --delete unlanded -> ALLOW" 0 "git branch --delete $DBMEMBER_BRANCH" "$R"; \
  rm -rf "$R"
R=$(mk_repo_unlanded_named "some/unrelated"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "force-delete unrelated branch -> ALLOW" 0 "git branch --force -d some/unrelated" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "branch rename is non-destructive -> ALLOW" 0 "git branch -m old new" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); \
  run_case "no DB named branch uses regex-only behavior -> ALLOW" 0 "git branch -D $DBMEMBER_BRANCH" "$R" "PENUMBRA_DB=/tmp/missing-penumbra-db-$$.sqlite"; \
  rm -rf "$R"
R=$(mk_repo_unlanded); \
  run_case "legacy uuid glued to semicolon before worktree prune -> BLOCK" 2 "git branch -D agent/$UUID; git worktree prune" "$R"; \
  rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member glued to semicolon before worktree prune -> BLOCK" 2 "git branch -D $DBMEMBER_BRANCH; git worktree prune" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member glued to subshell close -> BLOCK" 2 "git branch -D $DBMEMBER_BRANCH)" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member glued to && separator -> BLOCK" 2 "git branch -D $DBMEMBER_BRANCH&&echo x" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member double-quoted then subshell close -> BLOCK" 2 "git branch -D \"$DBMEMBER_BRANCH\")" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member single-quoted then semicolon -> BLOCK" 2 "git branch -D '$DBMEMBER_BRANCH';" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member double-quoted then && separator -> BLOCK" 2 "git branch -D \"$DBMEMBER_BRANCH\"&&echo x" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "$DBMEMBER_BRANCH"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "DB-member leading paren then double quote -> BLOCK" 2 "git branch -D (\"$DBMEMBER_BRANCH\"" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"
R=$(mk_repo_unlanded_named "feat/bar"); DB=$(mk_db_with_branch "$DBMEMBER_BRANCH"); \
  run_case "non-member glued to semicolon -> ALLOW" 0 "git branch -D feat/bar;" "$R" "PENUMBRA_DB=$DB"; \
  rm -f "$DB"; rm -rf "$R"

# non-destructive command -> ALLOW
R=$(mk_repo_unlanded);  run_case "non-destructive (git status) -> ALLOW" 0 "git status" "$R"; rm -rf "$R"

R=$(mk_repo_unlanded);  run_timing_case "400-token benign command without branch skips scanner" "$(long_benign_command "echo" 800)" "$R" 0.3; rm -rf "$R"
R=$(mk_repo_unlanded);  run_timing_case "400-token benign command with branch stays fast" "$(long_benign_command "echo branch")" "$R" 0.3; rm -rf "$R"

# fail-open: branch absent (delete a uuid that doesn't exist) -> ALLOW
R=$(mk_repo_ancestor);  run_case "branch absent -> ALLOW (fail-open)" 0 "git branch -D agent/00000000-0000-0000-0000-000000000000" "$R"; rm -rf "$R"

# fail-open: not a git repo -> ALLOW
NOREPO=$(mktemp -d);    run_case "no git repo -> ALLOW (fail-open)" 0 "$DEL" "$NOREPO"; rm -rf "$NOREPO"

# worktree remove derives the protected branch from the actual worktree path.
R=$(mk_repo_unlanded); WT=$(mktemp -d); rmdir "$WT"; git -C "$R" worktree add -q "$WT" "agent/$UUID"; \
  run_case "worktree remove unlanded -> BLOCK" 2 "git worktree remove --force $WT" "$R"; \
  git -C "$R" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$WT"; rm -rf "$R"

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
