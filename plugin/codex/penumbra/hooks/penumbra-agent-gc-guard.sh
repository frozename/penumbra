#!/usr/bin/env bash
# PreToolUse(Bash) guard: block destruction of UNLANDED penumbra agent work.
#
# Origin: a `dispatch_land` once failed (missing arg) while a bundled
# `git branch -D <handoff-branch>` + `git worktree remove` ran anyway, deleting a
# branch whose commit was not yet in the integration branch. This guard makes
# that class of mistake deterministically impossible: any command whose INTENT
# is to delete a branch (fleet, named, or one with a live worktree) is BLOCKED
# unless that branch's work is provably already in the base branch. When the
# target cannot be enumerated from the command string, the guard FAILS CLOSED.
#
# Three independent "safe" conditions (any one allows the delete):
#   1. tip is an ancestor of the base (fast-forward / merge land)
#   2. `git diff <ref> <base>` is empty (squash land — same content, new SHA)
#   3. the branch's OWN files are byte-identical in the base (stale-base squash:
#      base advanced past the merge-base via other landed commits)
#
# Override (any one), for intentional GC of merged/abandoned work:
#   - export PENUMBRA_ALLOW_AGENT_GC=1            (in the hook's environment)
#   - inline token:  PENUMBRA_ALLOW_AGENT_GC=1 git branch -D <handoff-branch>
#       (parsed from the command string — works across the hook process boundary)
#   - sentinel file present + fresh (<=300s):  touch ~/.claude/.penumbra-allow-agent-gc
#       (override path configurable via $PENUMBRA_ALLOW_AGENT_GC_SENTINEL)
#
# Contract: reads the PreToolUse JSON on stdin. To BLOCK, print to stderr and
# exit 2. Allow (exit 0) only when the command is non-destructive, or when it
# names one explicit, safe branch, or when the single-ref override is set.
# Destructive commands whose target cannot be enumerated FAIL CLOSED (exit 2).

set -uo pipefail

input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0

# --- extract the command + cwd from the payload (jq, then python3, else give up) ---
cmd=""
cwd=""
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
  cwd="$(printf '%s' "$input" | jq -r '.cwd // .tool_input.cwd // empty' 2>/dev/null)"
elif command -v python3 >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
print((d.get("tool_input") or {}).get("command","") or "")' 2>/dev/null)"
  cwd="$(printf '%s' "$input" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(d.get("cwd") or (d.get("tool_input") or {}).get("cwd") or "")' 2>/dev/null)"
fi
[ -n "$cmd" ] || exit 0   # could not parse the command → fail-open

# --- override resolution (any one allows the delete) ---------------------------
allow_override() {
  # 1. hook's own environment
  [ "${PENUMBRA_ALLOW_AGENT_GC:-}" = "1" ] && return 0
  # 2. inline token in the command string (the form operators actually type)
  case "$cmd" in
    *"PENUMBRA_ALLOW_AGENT_GC=1"*) return 0 ;;
  esac
  # 3. sentinel file present AND fresh (mtime within 300s) — auditable + TTL-bounded
  local sentinel="${PENUMBRA_ALLOW_AGENT_GC_SENTINEL:-$HOME/.claude/.penumbra-allow-agent-gc}"
  if [ -f "$sentinel" ]; then
    local now mtime age
    now=$(date +%s 2>/dev/null) || return 1
    # GNU stat first: GNU reads `-f %m` as "filesystem status of the file named %m",
    # prints the sentinel's filesystem block to stdout, then fails, so the BSD-first
    # order captured that text into mtime on Linux. BSD stat rejects -c silently.
    mtime=$(stat -c %Y "$sentinel" 2>/dev/null || stat -f %m "$sentinel" 2>/dev/null) || return 1
    age=$((now - mtime))
    [ "$age" -ge 0 ] && [ "$age" -le 300 ] && return 0
  fi
  return 1
}

clean_ref_token() {
  local ref=$1 prev
  while :; do
    prev=$ref
    ref=${ref#\"}; ref=${ref%\"}
    ref=${ref#\'}; ref=${ref%\'}
    ref=${ref#\(}
    case "$ref" in
      *$'\r') ref=${ref%$'\r'} ;;
    esac
    case "$ref" in
      *';'|*')'|*'&'|*'|'|*'`') ref=${ref%?} ;;
    esac
    [ "$ref" = "$prev" ] && break
  done
  ref=${ref#:}
  ref=${ref#refs/heads/}
  printf '%s\n' "$ref"
}

split_ref_token() {
  local token=$1
  token=${token//&&/$'\n'}
  token=${token//\|\|/$'\n'}
  token=${token//;/$'\n'}
  printf '%s\n' "$token"
}

has_command_separator() {
  case "$1" in
    *';'*|*'&&'*|*'||'*|*'|'*) return 0 ;;
    *) return 1 ;;
  esac
}

has_git_branch_delete_intent() {
  local token raw scan_cmd prev saw_git=0 branch_mode=0 restore_glob=0 found=1
  case $- in
    *f*) : ;;
    *) set -f; restore_glob=1 ;;
  esac
  scan_cmd=$cmd
  scan_cmd=${scan_cmd//&&/ ; }
  scan_cmd=${scan_cmd//\|\|/ ; }
  scan_cmd=${scan_cmd//;/ ; }
  scan_cmd=${scan_cmd//|/ ; }
  for raw in $scan_cmd; do
    if [ "$raw" = ";" ]; then
      saw_git=0
      branch_mode=0
      continue
    fi

    token=$raw
    while :; do
      prev=$token
      token=${token#\"}; token=${token%\"}
      token=${token#\'}; token=${token%\'}
      token=${token#\(}
      case "$token" in
        *$'\r') token=${token%$'\r'} ;;
      esac
      case "$token" in
        *')'|*'&'|*'|'|*'`') token=${token%?} ;;
      esac
      [ "$token" = "$prev" ] && break
    done
    token=${token#:}
    token=${token#refs/heads/}
    [ -n "$token" ] || continue

    case "$token" in
      git)
        saw_git=1
        branch_mode=0
        ;;
      branch)
        if [ "$saw_git" = 1 ]; then
          branch_mode=1
          saw_git=0
        fi
        ;;
      -d|-D|--delete)
        if [ "$branch_mode" = 1 ]; then
          found=0
          break
        fi
        ;;
    esac
    if has_command_separator "$raw"; then
      saw_git=0
      branch_mode=0
    fi
  done
  [ "$restore_glob" = 1 ] && set +f
  return "$found"
}

# --- match destructive INTENT, not one surface spelling ------------------------
# Covers branch force/normal delete, worktree removal, low-level ref deletion,
# and remote ref deletion (git push origin :ref / --delete ref).
has_non_branch_delete_intent() {
  case "$cmd" in
    *"git worktree remove"*|*"worktree remove --force"*) return 0 ;;
    *"git update-ref -d"*|*"update-ref --delete"*) return 0 ;;
    *"git push"*" --delete"*|*"git push"*" -d "*) return 0 ;;
    *"git push"*" :"*) return 0 ;;   # refspec deletion form: push <remote> :<ref>
    *) return 1 ;;
  esac
}

case "$cmd" in
  *branch*|*"git worktree remove"*|*"worktree remove --force"*|*"git update-ref -d"*|*"update-ref --delete"*|*"git push"*" --delete"*|*"git push"*" -d "*|*"git push"*" :"*) : ;;
  *) exit 0 ;;
esac

branch_delete_intent=1
case "$cmd" in
  *branch*)
    if has_git_branch_delete_intent; then
      branch_delete_intent=0
    fi
    ;;
esac

if [ "$branch_delete_intent" != 0 ] && ! has_non_branch_delete_intent; then
  exit 0
fi

# --- resolve the repo dir (hook cwd, else the surrounding git checkout) -------
repo="${cwd:-}"
[ -d "$repo/.git" ] || repo="${PENUMBRA_REPO:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -d "$repo/.git" ] || exit 0   # can't verify → fail-open

# --- which branch refs does the destructive command touch? --------------------
extract_candidate_refs() {
  local token raw prev="" branch_mode=0 push_delete_mode=0 worktree_path_next=0 restore_glob=0
  case $- in
    *f*) : ;;
    *) set -f; restore_glob=1 ;;
  esac
  for raw in $cmd; do
    while IFS= read -r token; do
      [ -n "$token" ] || continue
      raw=$token
      token="$(clean_ref_token "$token")"

      if [ "$worktree_path_next" = 1 ]; then
        case "$token" in
          -*) : ;;
          *)
            git -C "$token" rev-parse --abbrev-ref HEAD 2>/dev/null || true
            worktree_path_next=0
            ;;
        esac
        prev="$token"
        continue
      fi

      if [ "$branch_mode" = 1 ]; then
        case "$token" in
          branch|-D|-d|--delete|-*) : ;;
          *) printf '%s\n' "$token" ;;
        esac
      fi

      if [ "$push_delete_mode" = 1 ]; then
        case "$token" in
          -*) : ;;
          *) printf '%s\n' "$token" ;;
        esac
      fi

      case "$token" in
        branch) branch_mode=1 ;;
        update-ref) prev="update-ref"; continue ;;
        -d|--delete)
          if [ "$prev" = "update-ref" ]; then
            prev="update-ref-delete"
            continue
          fi
          push_delete_mode=1
          ;;
        worktree) prev="worktree"; continue ;;
        remove)
          if [ "$prev" = "worktree" ]; then
            worktree_path_next=1
            prev="$token"
            continue
          fi
          ;;
        *)
          case "$raw" in
            :*) clean_ref_token "$raw" ;;
          esac
          if [ "$prev" = "update-ref-delete" ]; then
            printf '%s\n' "$token"
            prev="$token"
            continue
          fi
          ;;
      esac
      prev="$token"
    done <<EOF
$(split_ref_token "$raw")
EOF
  done
  [ "$restore_glob" = 1 ] && set +f
}

extract_legacy_agent_refs() {
  local uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  printf '%s' "$cmd" | grep -oE "agent/${uuid}" 2>/dev/null || true
}

sqlite_escape() {
  local value=$1
  value=${value//\'/\'\'}
  printf '%s\n' "$value"
}

is_db_member_branch() {
  local ref=$1 db=${PENUMBRA_DB:-$HOME/.penumbra/db.sqlite} escaped out
  command -v sqlite3 >/dev/null 2>&1 || return 1
  [ -f "$db" ] || return 1
  escaped="$(sqlite_escape "$ref")"
  out="$(sqlite3 -readonly "file:${db}?mode=ro" "SELECT 1 FROM handoffs WHERE branch_name = '$escaped' LIMIT 1" 2>/dev/null)" || return 1
  [ "$out" = "1" ]
}

is_fleet_ref() {
  local ref=$1
  uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  printf '%s\n' "$ref" | grep -Eq "^agent/${uuid}$" && return 0
  is_db_member_branch "$ref"
}

is_explicit_ref_token() {
  local ref=$1
  [ -n "$ref" ] || return 1
  # Reject shell expansion, globs, redirections, separators.
  printf '%s' "$ref" | grep -qE '[][\\|;&$`()<>*?{}]' && return 1
  # Allow simple branch-shaped tokens: alphanumerics and ref separators.
  # First character cannot be '-' so we do not mistake a flag for a ref.
  printf '%s' "$ref" | grep -qE '^[A-Za-z0-9/._:@~+][A-Za-z0-9/._:@~+-]*$' || return 1
  return 0
}

has_shell_meta() {
  printf '%s' "$1" | grep -qE '[][\\|;&$`()<>*?{}]'
}

# --- enumerate concrete branch targets; fail-closed if we cannot. ------------
candidates="$({ extract_candidate_refs; extract_legacy_agent_refs; } | sort -u)"

has_non_explicit=0
explicit_nonexistent=0
refs=""

while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  if ! is_explicit_ref_token "$ref"; then
    has_non_explicit=1
    continue
  fi
  if git -C "$repo" rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
    refs="$refs $ref"
  else
    explicit_nonexistent=$((explicit_nonexistent + 1))
  fi
done <<< "$candidates"

refs=${refs# }

set -- $refs
refs_count=$#
explicit_total=$((refs_count + explicit_nonexistent))

# --- override is only for a single explicitly-named ref, not a sweep. --------
if [ "$explicit_total" -eq 1 ] && [ "$has_non_explicit" -eq 0 ] && ! has_shell_meta "$cmd" && allow_override; then
  exit 0
fi

if [ "$refs_count" -eq 0 ]; then
  if [ "$explicit_nonexistent" -eq 1 ] && [ "$has_non_explicit" -eq 0 ] && ! has_shell_meta "$cmd"; then
    # Single, non-existent, explicitly-named branch: nothing to protect.
    exit 0
  fi
  echo "BLOCKED: destructive command does not enumerate a single, explicitly-named branch to delete." >&2
  echo "If you intend to delete one branch, name it directly. For bulk GC, run one explicit ref at a time." >&2
  exit 2
fi

# --- resolve the integration base branch -------------------------------------
# Hardcoding "main" fails OPEN in any repo whose default branch differs:
# `git diff <ref> <missing-base>` prints nothing, which a safe-check would
# misread as "content already landed". Try main, master, then origin/HEAD.
# If none resolves, BASE stays empty and every "empty diff = safe" check is
# skipped → conservative (block).
BASE=""
for cand in main master; do
  if git -C "$repo" rev-parse --verify --quiet "$cand" >/dev/null 2>&1; then
    BASE="$cand"; break
  fi
done
if [ -z "$BASE" ]; then
  BASE="$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
fi

# --- evaluate each ref against the three safe conditions ----------------------
blocked=""
for ref in $refs; do
  # Branch doesn't exist → nothing to protect.
  git -C "$repo" rev-parse --verify --quiet "$ref" >/dev/null 2>&1 || continue

  # Safe (1): tip is an ancestor of the base (ff / merge land).
  if [ -n "$BASE" ] && git -C "$repo" merge-base --is-ancestor "$ref" "$BASE" 2>/dev/null; then
    continue
  fi

  # Safe (2): whole-branch diff vs base is empty (squash land, same content).
  if [ -n "$BASE" ] && [ -z "$(git -C "$repo" diff "$ref" "$BASE" 2>/dev/null)" ]; then
    continue
  fi

  # Safe (3): the branch's OWN files (merge-base..tip) are byte-identical in the
  # base. Covers a squash land where the base ALSO advanced past the merge-base
  # via unrelated landed commits, making the whole-branch diff non-empty even
  # though this branch's own work is fully landed.
  mb=""
  [ -n "$BASE" ] && mb="$(git -C "$repo" merge-base "$BASE" "$ref" 2>/dev/null)"
  if [ -n "$mb" ]; then
    own_files="$(git -C "$repo" diff --name-only "$mb" "$ref" 2>/dev/null)"
    if [ -n "$own_files" ]; then
      own_delta="$(printf '%s\n' "$own_files" | xargs -I{} git -C "$repo" diff "$ref" "$BASE" -- {} 2>/dev/null)"
      if [ -z "$own_delta" ]; then
        continue
      fi
    fi
  fi

  blocked="$blocked $ref"
done

if [ -n "$blocked" ]; then
  echo "BLOCKED: refusing to destroy UNLANDED agent work:${blocked}" >&2
  echo "Their work is not yet in the base branch (${BASE:-<unresolved>}) — deleting now loses the commits." >&2
  echo "Land first via dispatch_land (it tears down safely after squash). For intentional GC of" >&2
  echo "merged/abandoned work, prefix the command with PENUMBRA_ALLOW_AGENT_GC=1, or" >&2
  echo "touch ~/.claude/.penumbra-allow-agent-gc (valid 5 min) then retry." >&2
  exit 2
fi

exit 0
