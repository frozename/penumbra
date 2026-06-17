#!/usr/bin/env bash
# PreToolUse(Bash) guard: block destruction of UNLANDED penumbra agent work.
#
# Origin: a `dispatch_land` once failed (missing arg) while a bundled
# `git branch -D agent/<id>` + `git worktree remove` ran anyway, deleting a
# branch whose commit was not yet in the integration branch. This guard makes
# that class of mistake deterministically impossible: any command whose INTENT
# is to delete an `agent/<uuid>` ref or its worktree is BLOCKED unless that
# branch's work is provably already in the base branch.
#
# Three independent "safe" conditions (any one allows the delete):
#   1. tip is an ancestor of the base (fast-forward / merge land)
#   2. `git diff <ref> <base>` is empty (squash land — same content, new SHA)
#   3. the branch's OWN files are byte-identical in the base (stale-base squash:
#      base advanced past the merge-base via other landed commits)
#
# Override (any one), for intentional GC of merged/abandoned work:
#   - export PENUMBRA_ALLOW_AGENT_GC=1            (in the hook's environment)
#   - inline token:  PENUMBRA_ALLOW_AGENT_GC=1 git branch -D agent/<uuid>
#       (parsed from the command string — works across the hook process boundary)
#   - sentinel file present + fresh (<=300s):  touch ~/.claude/.penumbra-allow-agent-gc
#       (override path configurable via $PENUMBRA_ALLOW_AGENT_GC_SENTINEL)
#
# Contract: reads the PreToolUse JSON on stdin. To BLOCK, print to stderr and
# exit 2. Every other path exits 0 (fail-open) so the guard can never wedge a
# session — the threat model is the operator's own bundled mistake, not an
# adversary.

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
    mtime=$(stat -f %m "$sentinel" 2>/dev/null || stat -c %Y "$sentinel" 2>/dev/null) || return 1
    age=$((now - mtime))
    [ "$age" -ge 0 ] && [ "$age" -le 300 ] && return 0
  fi
  return 1
}
if allow_override; then
  exit 0
fi

# --- match destructive INTENT, not one surface spelling ------------------------
# Covers branch force/normal delete, worktree removal, low-level ref deletion,
# and remote ref deletion (git push origin :ref / --delete ref).
case "$cmd" in
  *"git branch -D"*|*"git branch -d"*) : ;;
  *"git worktree remove"*|*"worktree remove --force"*) : ;;
  *"git update-ref -d"*|*"update-ref --delete"*) : ;;
  *"git push"*" --delete"*|*"git push"*" -d "*) : ;;
  *"git push"*" :"*) : ;;   # refspec deletion form: push <remote> :<ref>
  *) exit 0 ;;
esac

# --- which agent/<uuid> refs does the command touch? --------------------------
uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
refs="$(printf '%s' "$cmd" | grep -oE "agent/${uuid}" | sort -u)"
[ -n "$refs" ] || exit 0

# --- resolve the repo dir (hook cwd, else the surrounding git checkout) -------
repo="${cwd:-}"
[ -d "$repo/.git" ] || repo="${PENUMBRA_REPO:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -d "$repo/.git" ] || exit 0   # can't verify → fail-open

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
