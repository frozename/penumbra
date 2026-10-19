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

# Sets $token to $1 minus the quotes, subshell parens and separators a word can
# carry glued on: ("feat/x") and 'feat/x'; both give feat/x. It assigns rather
# than prints so scanning every word of a long command forks nothing.
clean_token() {
  local prev
  token=$1
  while :; do
    prev=$token
    token=${token#\"}; token=${token%\"}
    token=${token#\'}; token=${token%\'}
    token=${token#\(}
    case "$token" in
      *$'\r') token=${token%$'\r'} ;;
    esac
    case "$token" in
      *';'|*')'|*'&'|*'|'|*'`') token=${token%?} ;;
    esac
    [ "$token" = "$prev" ] && break
  done
}

# Prints $cmd one simple command per line, so a delete flag is only read against
# the git subcommand it belongs to: `git branch x <sha>; ... | tr -d ' '` deletes
# nothing. Splits on unquoted ; & && || | |& and newlines; each $(...), <(...)
# and `...` body is its own commands and leaves $() in the outer one; comments
# are dropped. Quoting that does not balance only merges commands, which can add
# a delete match but never hide one. Heredoc bodies are still scanned (a body fed
# to a shell runs), one line at a time so an apostrophe in a commit message
# cannot merge everything after it.
simple_commands() {
  printf '%s\n' "$cmd" | LC_ALL=C awk '
    # stk has one letter per open context: q single quote, d double quote,
    # s $( <( >(, b backtick, c ${, p a paren inside s. s and b bodies are
    # printed on their own while saved[] holds the command around them.
    BEGIN { SQ = "\047" }
    function top() { return substr(stk, length(stk), 1) }
    function flush() { if (cur ~ /[^ \t]/) print cur; cur = "" }
    function take(i) { cur = cur substr(line, seg, i - seg); seg = i }
    function enter(kind, i, w) {
      if (kind == "s" || kind == "b") { take(i + w); saved[base + length(stk) + 1] = cur; cur = "" }
      stk = stk kind
    }
    function leave(i) {
      if (top() == "s" || top() == "b") { take(i); flush(); cur = saved[base + length(stk)] }
      stk = substr(stk, 1, length(stk) - 1)
    }
    function unwind() { while (stk != "") leave(seg); flush() }
    function heredoc(i, n,    j, ch, delim, strip) {
      j = i + 2
      if (substr(line, j, 1) == "-") { strip = 1; j++ }
      while (j <= n && index(" \t", substr(line, j, 1))) j++
      while (j <= n) {
        ch = substr(line, j, 1)
        if (index(" \t;|&<>()", ch)) break
        if (ch == "\\") { j++; ch = substr(line, j, 1) }
        else if (ch == SQ || ch == "\"") ch = ""
        delim = delim ch; j++
      }
      if (delim !~ /^[A-Za-z_]/) return i + 2
      hd[++hn] = delim; hs[hn] = strip
      return j
    }
    function scan(text,    n, i, c, c2, t) {
      line = text; seg = 1; n = length(line); i = 1
      while (i <= n) {
        c = substr(line, i, 1); c2 = substr(line, i, 2); t = top()
        if (t == "q") { if (c == SQ) leave(i); i++; continue }
        if (c == "\\") {
          if (i == n) { take(i); seg = n + 1; return 1 }
          i += 2; continue
        }
        if (c2 == "$(" || (t != "d" && (c2 == "<(" || c2 == ">("))) { enter("s", i, 2); i += 2; continue }
        if (c2 == "${") { enter("c", i, 2); i += 2; continue }
        if (c == "`") { if (t == "b") leave(i); else enter("b", i, 1); i++; continue }
        if (t == "d") { if (c == "\"") leave(i); i++; continue }
        if (c == SQ) { enter("q", i, 1); i++; continue }
        if (c == "\"") { enter("d", i, 1); i++; continue }
        if (t == "c") { if (c == "}") leave(i); i++; continue }
        if (c == "(" && t != "") { enter("p", i, 1); i++; continue }
        if (c == ")" && (t == "s" || t == "p")) { leave(i); i++; continue }
        if (c == "#" && t != "p" && (i == 1 || index(" \t;|&()", substr(line, i - 1, 1)))) { take(i); seg = n + 1; return 0 }
        if (c2 == "<<" && !hi && t != "p") {
          if (substr(line, i + 2, 1) == "<") i += 3
          else i = heredoc(i, n)
          continue
        }
        if (c == ";" || c == "|" || c == "&") {
          if (c == "&" && c2 != "&&" && ((i > 1 && index("<>", substr(line, i - 1, 1))) || substr(line, i + 1, 1) == ">")) { i++; continue }
          take(i); flush()
          i += (c2 == "&&" || c2 == "||" || c2 == "|&") ? 2 : 1
          seg = i; continue
        }
        i++
      }
      take(n + 1)
      return 0
    }
    {
      if (hi) {
        body = $0
        if (hs[hi]) sub(/^\t+/, "", body)
        if (body == hd[hi]) {
          unwind(); bcont = 0
          if (hi < hn) hi++
          else { hi = hn = base = 0; stk = sstk; cur = scur }
          next
        }
        if (!bcont) { stk = ""; cur = "" }
        if (!(bcont = scan($0))) unwind()
        next
      }
      if (!(more = scan($0))) {
        t = top()
        if (t == "" || t == "s" || t == "b" || t == "p") flush(); else cur = cur " "
      }
      if (hn && !more) { hi = 1; sstk = stk; scur = cur; base = length(stk) }
    }
    END { if (hi) { unwind(); stk = sstk; cur = scur; base = 0 } unwind() }
  ' 2>/dev/null
}

# --- match destructive INTENT, not one surface spelling ------------------------
# One simple command deletes a ref when it names git, then branch, push or
# update-ref, then a delete flag (or, for push, a :<ref> refspec), or when it
# runs git worktree remove.
has_delete_intent() {
  local raw token prev="" saw_git=0 branch=0 push=0 update_ref=0 restore_glob=0 found=1
  case "$1" in
    *git*) : ;;
    *) return 1 ;;
  esac
  case $- in
    *f*) : ;;
    *) set -f; restore_glob=1 ;;
  esac
  for raw in $1; do
    clean_token "$raw"
    case "$token" in
      git) saw_git=1 ;;
      branch) branch=$saw_git ;;
      push) push=$saw_git ;;
      update-ref) update_ref=$saw_git ;;
      remove) [ "$saw_git$prev" = 1worktree ] && found=0 ;;
      -D) [ "$branch" = 1 ] && found=0 ;;
      -d|--delete) [ "$branch$push$update_ref" != 000 ] && found=0 ;;
      :*) [ "$push" = 1 ] && found=0 ;;
    esac
    [ "$found" = 0 ] && break
    prev=$token
  done
  [ "$restore_glob" = 1 ] && set +f
  return "$found"
}

case "$cmd" in
  *branch*|*push*|*worktree*|*update-ref*) : ;;
  *) exit 0 ;;
esac

# No awk, or awk failed: judge the whole string as one command (fail closed).
simple_cmds="$(simple_commands)" || simple_cmds=${cmd//$'\n'/ }
delete_cmds=""
while IFS= read -r simple_cmd; do
  if has_delete_intent "$simple_cmd"; then
    delete_cmds="$delete_cmds$simple_cmd
"
  fi
done <<EOF
$simple_cmds
EOF
[ -n "$delete_cmds" ] || exit 0

# --- resolve the repo dir (hook cwd, else the surrounding git checkout) -------
repo="${cwd:-}"
[ -d "$repo/.git" ] || repo="${PENUMBRA_REPO:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -d "$repo/.git" ] || exit 0   # can't verify → fail-open

# --- which branch refs does the destructive command touch? --------------------
extract_candidate_refs() {
  local simple_cmd token raw prev branch_mode push_delete_mode worktree_path_next restore_glob=0
  case $- in
    *f*) : ;;
    *) set -f; restore_glob=1 ;;
  esac
  while IFS= read -r simple_cmd; do
    prev="" branch_mode=0 push_delete_mode=0 worktree_path_next=0
    for raw in $simple_cmd; do
      clean_token "$raw"
      raw=$token
      token=${token#:}
      token=${token#refs/heads/}
      [ -n "$token" ] || continue

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
            :*) printf '%s\n' "$token" ;;
          esac
          if [ "$prev" = "update-ref-delete" ]; then
            printf '%s\n' "$token"
            prev="$token"
            continue
          fi
          ;;
      esac
      prev="$token"
    done
  done <<EOF
$delete_cmds
EOF
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
