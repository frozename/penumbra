import {
  ARCHIVE_LIST_FLAGS,
  ARCHIVE_STDOUT_FLAGS,
  ARCHIVE_STDOUT_SHORT_RE,
  BENIGN_ENV_NAMES,
  BUILTIN_MUTATE_FLAGS,
  DANGEROUS_ENV_NAMES,
  DANGEROUS_ENV_PREFIXES,
  DENY_PROGRAMS,
  ENV_ASSIGNMENT_RE,
  FIND_DENY_FLAGS,
  GIT_BRANCH_DENY_FLAGS,
  GIT_BRANCH_LIST_FLAGS,
  GIT_CONFIG_READ_FLAGS,
  GIT_CONFIG_SCOPE_FLAGS,
  GIT_DENY_FLAGS,
  GIT_FSCK_WRITE_PREFIXES,
  GIT_GLOBAL_FLAGS,
  GIT_GLOBAL_OPTS_WITH_VALUE,
  GIT_GREP_EXEC_PREFIXES,
  GIT_LS_REMOTE_EXEC_PREFIXES,
  GIT_READ_VERBS,
  GIT_TAG_DENY_FLAGS,
  GIT_TAG_LIST_FLAGS,
  INTERPRETER_NAME_RE,
  PROGRAM_GLOB_RE,
  RG_DENY_FLAGS,
  SED_DENY_SCRIPT_RE,
  SETENV_BUILTINS,
  SHELL_KEYWORD_WORDS,
  UNIQ_VALUE_FLAGS,
} from "./shell-classifier-tables.js";
import { scanShellTokens, SUBST_MARKER, tokenizeShellCommand } from "./shell-tokenizer.js";

export type ShellClassifyResult = { decision: "allow" } | { decision: "deny"; reason: string };

function basenameOf(program: string): string {
  const normalized = program.replaceAll("\\", "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function commandWrapperSkip(argv: string[], i: number): number | null {
  // `command -v/-V` only print where a name resolves — return null so `command`
  // stays the program and the query form classifies benign. `command -p`/`--`
  // still exec the named program: return the index after the option words.
  let j = i + 1;
  while (argv[j] === "-p" || argv[j] === "--") j += 1;
  if (argv[j] === "-v" || argv[j] === "-V") return null;
  return j;
}

// `builtin <name>` still runs a shell builtin — skip it unless the invocation
// carries a flag that mutates shell state (e.g. `builtin -f` loads modules).
function builtinInvokeSkips(argv: string[], i: number): boolean {
  return !argv.slice(i + 1).some((arg) => BUILTIN_MUTATE_FLAGS.has(arg));
}

function skippableWord(argv: string[], i: number): boolean {
  const word = argv[i] ?? "";
  return (
    ENV_ASSIGNMENT_RE.test(word) ||
    SHELL_KEYWORD_WORDS.has(word) ||
    (word === "builtin" && builtinInvokeSkips(argv, i))
  );
}

function stripLeadingAssignments(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length) {
    const word = argv[i];
    if (word === undefined) break;
    if (word === "command") {
      const skip = commandWrapperSkip(argv, i);
      if (skip === null) break;
      i = skip;
      continue;
    }
    if (skippableWord(argv, i)) {
      i += 1;
      continue;
    }
    break;
  }
  return argv.slice(i);
}

function dangerousEnvAssignment(argv: string[]): string | null {
  // An assignment is dangerous when it actually lands in the environment of a
  // later command: leading FOO=bar words, or args to export/declare/readonly.
  let inAssignmentContext = true;
  for (const word of argv) {
    if (ENV_ASSIGNMENT_RE.test(word)) {
      const name = word.slice(0, word.indexOf("="));
      if (
        inAssignmentContext &&
        !BENIGN_ENV_NAMES.has(name) &&
        (DANGEROUS_ENV_NAMES.has(name) || DANGEROUS_ENV_PREFIXES.some((p) => name.startsWith(p)))
      ) {
        return name;
      }
      continue;
    }
    if (SETENV_BUILTINS.has(word)) {
      inAssignmentContext = true;
      continue;
    }
    inAssignmentContext = false;
  }
  return null;
}

function denyOnFlags(
  flags: ReadonlySet<string>,
  reason: (flag: string) => string,
): (rest: string[]) => string | null {
  return (rest) => {
    const hit = rest.find((arg) => flags.has(arg));
    return hit === undefined ? null : reason(hit);
  };
}

function denyOnMatch(
  pred: (arg: string) => boolean,
  reason: string,
): (rest: string[]) => string | null {
  return (rest) => (rest.some(pred) ? reason : null);
}

function classifySed(rest: string[]): string | null {
  const inPlace = denyOnMatch(
    (arg) => arg === "-i" || arg.startsWith("-i") || arg.startsWith("--in-place"),
    "sed -i edits files in place",
  )(rest);
  if (inPlace !== null) return inPlace;
  const script = denyOnMatch((arg) => SED_DENY_SCRIPT_RE.test(arg), "sed script has w/e command");
  return script(rest);
}

function classifyGitBranch(rest: string[]): string | null {
  let positionals = 0;
  for (const arg of rest) {
    if (GIT_BRANCH_DENY_FLAGS.has(arg) || arg.startsWith("--delete")) {
      return `git branch flag '${arg}' mutates refs`;
    }
    if (!arg.startsWith("-")) positionals += 1;
  }
  if (positionals > 0 && !rest.some((arg) => GIT_BRANCH_LIST_FLAGS.has(arg))) {
    return "git branch creates/renames refs";
  }
  return null;
}

function classifyGitTag(rest: string[]): string | null {
  let positionals = 0;
  for (const arg of rest) {
    if (GIT_TAG_DENY_FLAGS.has(arg) || arg.startsWith("--delete")) {
      return `git tag flag '${arg}' mutates refs`;
    }
    if (!arg.startsWith("-")) positionals += 1;
  }
  if (positionals > 0 && !rest.some((arg) => GIT_TAG_LIST_FLAGS.has(arg))) {
    return "git tag creates refs";
  }
  return null;
}

function classifyGitStash(rest: string[]): string | null {
  const sub = rest[0];
  if (sub === "list" || sub === "show") return null;
  return `git stash ${sub ?? "push"} mutates the working tree`;
}

function classifyGitWorktree(rest: string[]): string | null {
  const sub = rest[0];
  if (sub === undefined || sub === "list") return null;
  return `git worktree ${sub} mutates`;
}

function classifyGitRemote(rest: string[]): string | null {
  const sub = rest[0];
  if (sub === undefined || sub === "-v" || sub === "--verbose") return null;
  if (sub === "show" || sub === "get-url") return null;
  return `git remote ${sub} mutates config`;
}

function classifyGitConfig(rest: string[]): string | null {
  const hasReadFlag = rest.some((arg) => GIT_CONFIG_READ_FLAGS.has(arg) || arg.startsWith("--get"));
  const writeFlag = rest.some(
    (arg) =>
      arg.startsWith("-") && !GIT_CONFIG_READ_FLAGS.has(arg) && !GIT_CONFIG_SCOPE_FLAGS.has(arg),
  );
  if (!hasReadFlag || writeFlag) return "git config without a read selector writes config";
  return null;
}

function classifyGitNotes(rest: string[]): string | null {
  const sub = rest[0];
  if (sub === undefined || sub === "list" || sub === "show" || sub === "get-ref") return null;
  return `git notes ${sub} mutates`;
}

function classifyGitSubmodule(rest: string[]): string | null {
  const sub = rest[0];
  if (sub === undefined || sub === "status") return null;
  return `git submodule ${sub} mutates`;
}

function classifyGitReflog(rest: string[]): string | null {
  const hit = rest.find((arg) => arg === "expire" || arg === "delete");
  return hit === undefined ? null : `git reflog ${hit} mutates`;
}

function classifyGitSymbolicRef(rest: string[]): string | null {
  let positionals = 0;
  for (const arg of rest) {
    if (arg === "-d" || arg === "--delete" || arg === "--update") {
      return `git symbolic-ref ${arg} mutates`;
    }
    if (!arg.startsWith("-")) positionals += 1;
  }
  if (positionals > 1) return "git symbolic-ref writes refs";
  return null;
}

function denyOnAnyPrefix(
  prefixes: readonly string[],
  reason: string,
): (rest: string[]) => string | null {
  return denyOnMatch((arg) => prefixes.some((p) => arg.startsWith(p)), reason);
}

const GIT_SUBCLASSIFIERS: Record<string, (rest: string[]) => string | null> = {
  branch: classifyGitBranch,
  config: classifyGitConfig,
  fsck: denyOnAnyPrefix(GIT_FSCK_WRITE_PREFIXES, "git fsck --lost-found writes lost refs"),
  grep: denyOnAnyPrefix(GIT_GREP_EXEC_PREFIXES, "git grep pager flags execute a program"),
  "ls-remote": denyOnAnyPrefix(
    GIT_LS_REMOTE_EXEC_PREFIXES,
    "git ls-remote --upload-pack executes a command",
  ),
  notes: classifyGitNotes,
  reflog: classifyGitReflog,
  remote: classifyGitRemote,
  stash: classifyGitStash,
  submodule: classifyGitSubmodule,
  "symbolic-ref": classifyGitSymbolicRef,
  tag: classifyGitTag,
  worktree: classifyGitWorktree,
};

function gitGlobalOptDeny(arg: string): string | null {
  if (arg === "-c" || arg === "--config-env" || arg.startsWith("--config-env=")) {
    return "git -c/--config-env injects arbitrary config execution";
  }
  if (arg === "--exec-path" || arg.startsWith("--exec-path=")) {
    return "git --exec-path injects arbitrary commands";
  }
  if (arg.startsWith("-") && !isSkippableGitGlobalOpt(arg)) {
    return `unrecognized git global option '${arg}'`;
  }
  return null;
}

function isSkippableGitGlobalOpt(arg: string): boolean {
  if (GIT_GLOBAL_OPTS_WITH_VALUE.has(arg) || GIT_GLOBAL_FLAGS.has(arg)) return true;
  return (
    arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || arg.startsWith("--namespace=")
  );
}

function gitGlobalOptWalk(argv: string[]): { deny: string | null; subIndex: number } {
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;
    const deny = gitGlobalOptDeny(arg);
    if (deny !== null) return { deny, subIndex: i };
    if (!arg.startsWith("-")) break;
    i += GIT_GLOBAL_OPTS_WITH_VALUE.has(arg) && !arg.includes("=") ? 2 : 1;
  }
  return { deny: null, subIndex: i };
}

function gitRestDeny(subcommand: string, rest: string[]): string | null {
  const hit = rest.find((arg) => GIT_DENY_FLAGS.has(arg) || arg.startsWith("--output="));
  return hit === undefined ? null : `git ${subcommand} flag '${hit}' writes output`;
}

// An argument word that is a bare substitution ($X or the __SUB__ placeholder)
// or a flag-looking word containing one resolves at exec time — a flag-deny
// handler inspecting the literal argv would miss the flag it materializes.
// Embedded uses like `sed 's/$/x/'` or `rev:path` keep working.
function isRuntimeExpandedArgWord(arg: string): boolean {
  const t = arg.trim();
  if (t === SUBST_MARKER || t.startsWith("$")) return true;
  return t.startsWith("-") && (t.includes(SUBST_MARKER) || t.includes("$"));
}

// name -> candidate literal values. null marks a name that IS bound somewhere
// in the command line but through a form we cannot inspect (second binding,
// `while read`, `for x in $(...)`, export/declare, mapfile, getopts,
// `printf -v`, or a non-literal value) — references to it stay denied.
type BindingMap = Map<string, string[] | null>;

const SHELL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Any second binding of the same name disqualifies it — the classifier does
// not track statement ordering, so it stays uninspectable either way.
function recordBinding(map: BindingMap, name: string, values: string[] | null): void {
  if (map.has(name)) {
    map.set(name, null);
    return;
  }
  map.set(name, values);
}

// A binding value is literal when nothing in it expands at exec time: no
// expansion '$' (sentinel-marked literal dollars are fine), no command
// substitution, no glob metacharacters, no tilde expansion.
function isLiteralWord(word: string): boolean {
  return !/[$*?[\]~]/.test(word) && !word.includes(SUBST_MARKER);
}

function markBindingNames(argv: readonly string[], map: BindingMap): void {
  for (const arg of argv) {
    if (SHELL_NAME_RE.test(arg)) recordBinding(map, arg, null);
  }
}

function markSetenvBindings(args: string[], map: BindingMap): void {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const eq = arg.indexOf("=");
    markBindingNames([eq === -1 ? arg : arg.slice(0, eq)], map);
  }
}

function collectDisqualifierAt(argv: string[], i: number, w: string, map: BindingMap): void {
  if (w === "read" || w === "getopts" || w === "mapfile" || w === "readarray") {
    markBindingNames(argv.slice(i + 1), map);
    return;
  }
  if (w === "printf") {
    const nxt = argv[i + 1] ?? "";
    const vArg = nxt === "-v" ? argv[i + 2] : nxt.startsWith("-v") ? nxt.slice(2) : undefined;
    if (vArg !== undefined) markBindingNames([vArg], map);
    return;
  }
  if (SETENV_BUILTINS.has(w)) markSetenvBindings(argv.slice(i + 1), map);
}

function collectForBinding(argv: string[], map: BindingMap): void {
  const name = argv[1] ?? "";
  if (!SHELL_NAME_RE.test(name)) return;
  const list = argv[2] === "in" ? argv.slice(3) : null;
  recordBinding(map, name, list?.every(isLiteralWord) === true ? list : null);
}

// A standalone assignment statement binds for the rest of the line — also
// behind a control keyword (`do n=5`, `then x=1`). The `NAME=v cmd` prefix
// form does NOT count: it only lands in the command's own environment and
// never feeds a $NAME expansion in the same command.
function collectAssignmentBindings(argv: string[], map: BindingMap): boolean {
  let k = 0;
  while (k < argv.length && SHELL_KEYWORD_WORDS.has(argv[k] ?? "")) k += 1;
  const body = argv.slice(k);
  if (body.length === 0 || !body.every((w) => ENV_ASSIGNMENT_RE.test(w))) return false;
  for (const w of body) {
    const eq = w.indexOf("=");
    const value = w.slice(eq + 1);
    recordBinding(map, w.slice(0, eq), isLiteralWord(value) ? [value] : null);
  }
  return true;
}

function collectSegmentBindings(argv: string[], map: BindingMap): void {
  if (argv.length === 0) return;
  const head = argv[0];
  if (head === "for" || head === "select") {
    collectForBinding(argv, map);
    return;
  }
  if (collectAssignmentBindings(argv, map)) return;
  for (const [i, w] of argv.entries()) collectDisqualifierAt(argv, i, w, map);
}

const EXPANSION_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const MAX_ARG_VARIANTS = 256;

// Resolve a flagged argv word against same-command literal bindings into its
// substitution variants. Returns null when any expansion is uninspectable:
// command substitutions, parameter operators (${f%%:*}, ${x:-d}), special
// parameters ($1, $@, $$), and unbound or re-bound names.
function substitutionVariants(
  word: string,
  refs: readonly { raw: string; name: string }[],
  bindings: BindingMap,
): string[] | null {
  let variants = [word];
  for (const ref of refs) {
    const values = bindings.get(ref.name);
    if (values === undefined || values === null) return null;
    const next: string[] = [];
    for (const v of variants) {
      for (const val of values) next.push(v.replaceAll(ref.raw, val));
    }
    if (next.length > MAX_ARG_VARIANTS) return null;
    variants = next;
  }
  return variants;
}

function resolveExpandedWord(word: string, bindings: BindingMap): string[] | null {
  if (word.includes(SUBST_MARKER)) return null;
  const refs: { raw: string; name: string }[] = [];
  for (const m of word.matchAll(EXPANSION_REF_RE)) {
    const name = m[1] ?? m[2];
    if (name !== undefined) refs.push({ raw: m[0], name });
  }
  if (word.replaceAll(EXPANSION_REF_RE, "").includes("$")) return null;
  return substitutionVariants(word, refs, bindings);
}

// One argv word -> the word-list each substitution variant splices in.
// Whitespace in a resolved value splits into separate argv words — the
// deny-safe read of the quoting provenance the tokenizer drops.
function argWordChoices(arg: string, bindings: BindingMap): string[][] | null {
  if (!isRuntimeExpandedArgWord(arg)) return [[arg]];
  const forms = resolveExpandedWord(arg, bindings);
  if (forms === null) return null;
  return forms.map((form) => form.split(/\s+/).filter((w) => w.length > 0));
}

// Produce every argv a command can take under the literal bindings: flagged
// words fan out per candidate value. null = at least one expansion is
// uninspectable.
function expandArgv(argv: string[], bindings: BindingMap): string[][] | null {
  let variants: string[][] = [[]];
  for (const arg of argv) {
    const choices = argWordChoices(arg, bindings);
    if (choices === null) return null;
    const next: string[][] = [];
    for (const base of variants) {
      for (const words of choices) next.push([...base, ...words]);
    }
    if (next.length > MAX_ARG_VARIANTS) return null;
    variants = next;
  }
  return variants;
}

function classifyGitResolved(argv: string[]): string | null {
  const walk = gitGlobalOptWalk(argv);
  if (walk.deny !== null) return walk.deny;
  const subcommand = argv[walk.subIndex];
  if (subcommand === undefined) return null;
  const subHandler = GIT_SUBCLASSIFIERS[subcommand];
  if (subHandler === undefined && !GIT_READ_VERBS.has(subcommand)) {
    return `git ${subcommand} is not a read-only subcommand`;
  }
  const rest = argv.slice(walk.subIndex + 1);
  return gitRestDeny(subcommand, rest) ?? (subHandler === undefined ? null : subHandler(rest));
}

function classifyGit(argv: string[], bindings: BindingMap): string | null {
  const variants = expandArgv(argv.slice(1), bindings);
  if (variants === null) {
    const expanded = argv.slice(1).find(isRuntimeExpandedArgWord);
    return `git argument '${expanded?.trim() ?? ""}' resolves at runtime`;
  }
  for (const tail of variants) {
    const deny = classifyGitResolved([argv[0] ?? "git", ...tail]);
    if (deny !== null) return deny;
  }
  return null;
}

const AWK_NAME_START = /[A-Za-z_]/;
const AWK_NAME_CHAR = /[A-Za-z0-9_]/;
// Chars after which a `/` opens a regex literal rather than a division —
// operand-enders like `)`, `"`, `$` or an identifier tail mean division.
const AWK_REGEX_PRECEDER_CHARS = "([{,;=~!&|?+-*%^<>\n}";
// Keywords that can be followed directly by a regex literal (print /re/,
// return /re/, ...). The remaining ident-tail case is a division.
const AWK_REGEX_KEYWORDS = new Set([
  "case",
  "default",
  "delete",
  "do",
  "else",
  "exit",
  "for",
  "getline",
  "if",
  "in",
  "next",
  "nextfile",
  "print",
  "printf",
  "return",
  "switch",
  "while",
]);

function awkWordAt(src: string, i: number): { word: string; end: number } {
  let j = i;
  while (j < src.length && AWK_NAME_CHAR.test(src[j] ?? "")) j += 1;
  return { word: src.slice(i, j), end: j };
}

function skipAwkDoubleQuoted(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length && src[j] !== '"') {
    if (src[j] === "\\") j += 1;
    j += 1;
  }
  return j + 1;
}

function skipAwkRegex(src: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1;
    else if (c === "\n") break;
    j += 1;
  }
  return j;
}

function awkRegexStarts(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (src[j] === " " || src[j] === "\t")) j -= 1;
  const prev = src[j];
  if (prev === undefined) return true;
  if (AWK_REGEX_PRECEDER_CHARS.includes(prev)) return true;
  if (!AWK_NAME_CHAR.test(prev)) return false;
  const end = j + 1;
  while (j >= 0 && AWK_NAME_CHAR.test(src[j] ?? "")) j -= 1;
  return AWK_REGEX_KEYWORDS.has(src.slice(j + 1, end));
}

function awkGetlineFollows(src: string, i: number): boolean {
  let k = i + 1;
  if (src[k] === "&") k += 1;
  while (src[k] === " " || src[k] === "\t") k += 1;
  return awkWordAt(src, k).word === "getline";
}

function awkSystemParenAt(src: string, i: number): boolean {
  let k = i;
  while (src[k] === " " || src[k] === "\t") k += 1;
  return src[k] === "(";
}

interface AwkScanState {
  depth: number;
  inPrint: boolean;
  deny: boolean;
}

// `>`/`>>`/`|`/`|&` inside a print statement at paren depth 0 write or pipe.
// `>=` is a comparison and `||` a logical OR. `| getline` executes at any
// depth ("cmd" | getline, including inside parens).
function awkRedirectStep(src: string, i: number, st: AwkScanState): number {
  if ((src[i] === "|" && src[i + 1] === "|") || (src[i] === ">" && src[i + 1] === "=")) {
    return i + 2;
  }
  if (src[i] === "|" && awkGetlineFollows(src, i)) st.deny = true;
  else if (st.inPrint && st.depth === 0) st.deny = true;
  return i + 1;
}

function awkOpStep(src: string, i: number, st: AwkScanState): number | null {
  const ch = src[i];
  if (ch === "(") {
    st.depth += 1;
    return i + 1;
  }
  if (ch === ")") {
    st.depth = Math.max(0, st.depth - 1);
    return i + 1;
  }
  if (ch === ";" || ch === "{" || ch === "}") {
    st.inPrint = false;
    return i + 1;
  }
  if (ch === "\n" && st.depth === 0) {
    st.inPrint = false;
    return i + 1;
  }
  if (ch === ">" || ch === "|") return awkRedirectStep(src, i, st);
  return null;
}

function awkWordStep(src: string, i: number, st: AwkScanState): number | null {
  const ch = src[i] ?? "";
  if (!AWK_NAME_START.test(ch)) return null;
  const { word, end } = awkWordAt(src, i);
  if (word === "print" || word === "printf") st.inPrint = true;
  else if (word === "system" && awkSystemParenAt(src, end)) st.deny = true;
  return end;
}

// Scans an awk program argument for exec/write constructs a regex can't see
// across quoting: print/printf redirection and pipes, system(), and
// "cmd" | getline. Statement boundaries (; { } and depth-0 newlines) end a
// print statement, so `print a} $1 > 3`-style comparisons stay allowed.
function awkScriptDenies(src: string): boolean {
  const st: AwkScanState = { depth: 0, inPrint: false, deny: false };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === '"') {
      i = skipAwkDoubleQuoted(src, i);
      continue;
    }
    if (ch === "/" && awkRegexStarts(src, i)) {
      i = skipAwkRegex(src, i);
      continue;
    }
    i = awkWordStep(src, i, st) ?? awkOpStep(src, i, st) ?? i + 1;
    if (st.deny) return true;
  }
  return st.deny;
}

function classifyAwk(rest: string[]): string | null {
  return rest.some(awkScriptDenies) ? "awk script executes commands or writes files" : null;
}

function classifyArchiveInPlace(rest: string[]): string | null {
  // -l/--list and -t/--test are pure reads; --rm still deletes the input.
  if (rest.some((arg) => ARCHIVE_LIST_FLAGS.has(arg)) && !rest.includes("--rm")) {
    return null;
  }
  const toStdout = rest.some(
    (arg) => ARCHIVE_STDOUT_FLAGS.has(arg) || ARCHIVE_STDOUT_SHORT_RE.test(arg),
  );
  return toStdout ? null : "compressor without -c/--stdout mutates files in place";
}

// `-` and /dev/stdout are not files — `sort -o` to either stays a read.
const SORT_STDOUT_TARGETS = new Set(["-", "/dev/stdout", "/dev/fd/1"]);

function sortOutputTarget(arg: string, next: string | undefined): string | null {
  if (arg === "-o" || arg === "--output") return next ?? "";
  if (arg.startsWith("--output=")) return arg.slice("--output=".length);
  if (!arg.startsWith("--") && arg.startsWith("-o")) return arg.slice(2);
  return null;
}

function classifySort(rest: string[]): string | null {
  for (const [i, arg] of rest.entries()) {
    const target = sortOutputTarget(arg, rest[i + 1]);
    if (target !== null && !SORT_STDOUT_TARGETS.has(target)) {
      return "sort -o/--output writes a file";
    }
  }
  return null;
}

function classifyUniq(rest: string[]): string | null {
  let positionals = 0;
  let skipNext = false;
  for (const arg of rest) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (UNIQ_VALUE_FLAGS.has(arg)) skipNext = true;
      continue;
    }
    positionals += 1;
  }
  return positionals >= 2 ? "uniq writes an output file with two operands" : null;
}

const AWK_HANDLER = classifyAwk;
const ARCHIVE_HANDLER = classifyArchiveInPlace;

const PROGRAM_HANDLERS: Record<string, (rest: string[]) => string | null> = {
  awk: AWK_HANDLER,
  gawk: AWK_HANDLER,
  mawk: AWK_HANDLER,
  nawk: AWK_HANDLER,
  biome: denyOnMatch(
    (arg) => arg === "--write" || arg === "--apply" || arg === "--fix",
    "biome write flags write",
  ),
  bzip2: ARCHIVE_HANDLER,
  bunzip2: ARCHIVE_HANDLER,
  xz: ARCHIVE_HANDLER,
  unxz: ARCHIVE_HANDLER,
  zstd: ARCHIVE_HANDLER,
  unzstd: ARCHIVE_HANDLER,
  lz4: ARCHIVE_HANDLER,
  unlz4: ARCHIVE_HANDLER,
  lzma: ARCHIVE_HANDLER,
  unlzma: ARCHIVE_HANDLER,
  date: denyOnMatch((arg) => arg === "-s" || arg === "--set", "date -s mutates system time"),
  eslint: denyOnMatch((arg) => arg.startsWith("--fix"), "eslint --fix writes"),
  find: denyOnFlags(FIND_DENY_FLAGS, (flag) => `find ${flag} writes or executes`),
  gofmt: denyOnMatch((arg) => arg === "-w" || arg === "--write", "gofmt -w writes"),
  gofumpt: denyOnMatch((arg) => arg === "-w" || arg === "--write", "gofumpt -w writes"),
  hostname: (rest) => (rest.length > 0 ? "hostname with an argument mutates" : null),
  prettier: denyOnMatch(
    (arg) => arg === "-w" || arg.startsWith("--write"),
    "prettier --write writes",
  ),
  rg: denyOnMatch(
    (arg) => RG_DENY_FLAGS.has(arg) || arg.startsWith("--pre="),
    "rg --pre/--hostname-bin executes a helper",
  ),
  sed: classifySed,
  sort: classifySort,
  uniq: classifyUniq,
  xxd: denyOnMatch((arg) => arg === "-r", "xxd -r writes"),
  yq: denyOnMatch(
    (arg) => arg === "-i" || arg === "--inplace" || arg === "-w",
    "yq in-place flags write",
  ),
};

function classifyNonGitProgram(
  program: string,
  rest: string[],
  bindings: BindingMap,
): string | null {
  if (program.startsWith("git-")) return `custom git command '${program}' may mutate`;
  const handler = PROGRAM_HANDLERS[program];
  if (handler !== undefined) {
    const variants = expandArgv(rest, bindings);
    if (variants === null) {
      const expanded = rest.find(isRuntimeExpandedArgWord);
      return `argument '${expanded?.trim() ?? ""}' resolves to a flag at runtime`;
    }
    for (const variant of variants) {
      const deny = handler(variant);
      if (deny !== null) return deny;
    }
    return null;
  }
  if (INTERPRETER_NAME_RE.test(program)) {
    return `'${program}' is an interpreter or code runner`;
  }
  return DENY_PROGRAMS.has(program) ? `'${program}' is a mutating or side-effect command` : null;
}

function classifyArgv(argv: string[], bindings: BindingMap): string | null {
  const dangerousEnv = dangerousEnvAssignment(argv);
  if (dangerousEnv !== null) return `env assignment '${dangerousEnv}=' enables code injection`;
  const stripped = stripLeadingAssignments(argv);
  const programWord = stripped[0] ?? "";
  // `$r`, `${cmd}`, `$"..."` or a command-substitution word in program
  // position resolve at runtime — uninspectable, so deny rather than guess.
  if (programWord.includes("$") || programWord.includes(SUBST_MARKER)) {
    return "indirect command name is uninspectable";
  }
  // A program word carrying glob metacharacters expands to a path the
  // classifier never sees (`/bin/r?`, `/bin/[r]m`) — uninspectable. Bare `[`
  // is the test builtin, not a glob.
  if (PROGRAM_GLOB_RE.test(programWord) && basenameOf(programWord) !== "[") {
    return "glob metacharacters in program name are uninspectable";
  }
  const program = basenameOf(programWord);
  if (program === "") return null;
  if (program === "builtin") {
    const hit = stripped.slice(1).find((arg) => BUILTIN_MUTATE_FLAGS.has(arg));
    return hit === undefined ? null : `builtin ${hit} loads or removes shell builtins`;
  }
  if (program === "git") return classifyGit(stripped, bindings);
  return classifyNonGitProgram(program, stripped.slice(1), bindings);
}

/**
 * Classify a pre-tokenized argv (e.g. ACP terminal/create `args`). Unlike
 * classifyShellCommand no shell re-parse happens: operators in argv members
 * are data, not syntax. Leading env assignments and wrapper prefixes still
 * apply because argv can carry them directly.
 */
export function classifyShellArgv(argv: readonly string[]): ShellClassifyResult {
  const deny = classifyArgv([...argv], new Map());
  return deny === null ? { decision: "allow" } : { decision: "deny", reason: deny };
}

/**
 * Layer A command classifier for review_readonly: a denylist of mutating
 * verbs, NOT an allowlist. Everything unmatched is allowed — Layer B
 * (sandbox-exec file-write* denial) is the structural guarantee; this layer
 * gives legible early denials for the observed mutation paths.
 */
export function classifyShellCommand(command: string): ShellClassifyResult {
  return classifyCommandWithBindings(command, new Map());
}

// Command substitutions see the enclosing command's bindings — a for-loop
// variable is in scope inside a `$(...)` in its body.
function classifyCommandWithBindings(command: string, inherited: BindingMap): ShellClassifyResult {
  const { toks, inner } = tokenizeShellCommand(command);
  const { segments, redirectDeny } = scanShellTokens(toks);
  if (redirectDeny !== null) return { decision: "deny", reason: redirectDeny };
  const bindings: BindingMap = new Map(inherited);
  for (const segment of segments) collectSegmentBindings(segment, bindings);
  for (const sub of inner) {
    const result = classifyCommandWithBindings(sub, bindings);
    if (result.decision === "deny") return result;
  }
  for (const segment of segments) {
    const deny = classifyArgv(segment, bindings);
    if (deny !== null) return { decision: "deny", reason: deny };
  }
  return { decision: "allow" };
}
