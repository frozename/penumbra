import {
  BUILTIN_MUTATE_FLAGS,
  DANGEROUS_ENV_NAMES,
  DENY_PROGRAMS,
  ENV_ASSIGNMENT_RE,
  FIND_DENY_FLAGS,
  GIT_BRANCH_DENY_FLAGS,
  GIT_BRANCH_LIST_FLAGS,
  GIT_CONFIG_READ_FLAGS,
  GIT_CONFIG_SCOPE_FLAGS,
  GIT_DENY_FLAGS,
  GIT_GLOBAL_FLAGS,
  GIT_GLOBAL_OPTS_WITH_VALUE,
  GIT_READ_VERBS,
  GIT_TAG_DENY_FLAGS,
  GIT_TAG_LIST_FLAGS,
  RG_DENY_FLAGS,
  SED_DENY_SCRIPT_RE,
  SETENV_BUILTINS,
  SHELL_KEYWORD_WORDS,
} from "./shell-classifier-tables.js";
import { scanShellTokens, tokenizeShellCommand } from "./shell-tokenizer.js";

export type ShellClassifyResult = { decision: "allow" } | { decision: "deny"; reason: string };

function basenameOf(program: string): string {
  const normalized = program.replaceAll("\\", "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function stripLeadingAssignments(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length) {
    const word = argv[i];
    if (word === undefined) break;
    if (word === "command" || ENV_ASSIGNMENT_RE.test(word) || SHELL_KEYWORD_WORDS.has(word)) {
      i += 1;
      continue;
    }
    if (word === "builtin") {
      const rest = argv.slice(i + 1);
      if (rest.some((arg) => BUILTIN_MUTATE_FLAGS.has(arg))) break;
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
      if (inAssignmentContext && DANGEROUS_ENV_NAMES.has(name)) return name;
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

const GIT_SUBCLASSIFIERS: Record<string, (rest: string[]) => string | null> = {
  branch: classifyGitBranch,
  config: classifyGitConfig,
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

function classifyGit(argv: string[]): string | null {
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

const PROGRAM_HANDLERS: Record<string, (rest: string[]) => string | null> = {
  biome: denyOnMatch(
    (arg) => arg === "--write" || arg === "--apply" || arg === "--fix",
    "biome write flags write",
  ),
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
  xxd: denyOnMatch((arg) => arg === "-r", "xxd -r writes"),
  yq: denyOnMatch(
    (arg) => arg === "-i" || arg === "--inplace" || arg === "-w",
    "yq in-place flags write",
  ),
};

function classifyNonGitProgram(program: string, rest: string[]): string | null {
  if (program.startsWith("git-")) return `custom git command '${program}' may mutate`;
  const handler = PROGRAM_HANDLERS[program];
  if (handler !== undefined) return handler(rest);
  return DENY_PROGRAMS.has(program) ? `'${program}' is a mutating or side-effect command` : null;
}

function classifyArgv(argv: string[]): string | null {
  const dangerousEnv = dangerousEnvAssignment(argv);
  if (dangerousEnv !== null) return `env assignment '${dangerousEnv}=' enables code injection`;
  const stripped = stripLeadingAssignments(argv);
  const programWord = stripped[0] ?? "";
  // `$r`, `${cmd}`, `$"..."` or a command-substitution word in program
  // position resolve at runtime — uninspectable, so deny rather than guess.
  if (programWord.includes("$") || programWord.includes("__SUB__")) {
    return "indirect command name is uninspectable";
  }
  const program = basenameOf(programWord);
  if (program === "") return null;
  if (program === "builtin") {
    const hit = stripped.slice(1).find((arg) => BUILTIN_MUTATE_FLAGS.has(arg));
    return hit === undefined ? null : `builtin ${hit} loads or removes shell builtins`;
  }
  if (program === "git") return classifyGit(stripped);
  return classifyNonGitProgram(program, stripped.slice(1));
}

/**
 * Classify a pre-tokenized argv (e.g. ACP terminal/create `args`). Unlike
 * classifyShellCommand no shell re-parse happens: operators in argv members
 * are data, not syntax. Leading env assignments and wrapper prefixes still
 * apply because argv can carry them directly.
 */
export function classifyShellArgv(argv: readonly string[]): ShellClassifyResult {
  const deny = classifyArgv([...argv]);
  return deny === null ? { decision: "allow" } : { decision: "deny", reason: deny };
}

/**
 * Layer A command classifier for review_readonly: a denylist of mutating
 * verbs, NOT an allowlist. Everything unmatched is allowed — Layer B
 * (sandbox-exec file-write* denial) is the structural guarantee; this layer
 * gives legible early denials for the observed mutation paths.
 */
export function classifyShellCommand(command: string): ShellClassifyResult {
  const { toks, inner } = tokenizeShellCommand(command);
  for (const sub of inner) {
    const result = classifyShellCommand(sub);
    if (result.decision === "deny") return result;
  }
  const { segments, redirectDeny } = scanShellTokens(toks);
  if (redirectDeny !== null) return { decision: "deny", reason: redirectDeny };
  for (const segment of segments) {
    const deny = classifyArgv(segment);
    if (deny !== null) return { decision: "deny", reason: deny };
  }
  return { decision: "allow" };
}
