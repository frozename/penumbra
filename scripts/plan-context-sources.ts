/**
 * Repo-source extractors for scripts/plan-context.ts.
 *
 * Each function DERIVES one authoring constraint from the file that actually
 * enforces it, so the emitted context cannot drift from the code: the phase
 * header regex comes from the registrar that greps with it, the task-id
 * patterns from the plan-meta schema that validates them, the gate commands
 * from the CI workflow that runs them.
 *
 * Also owns PlanContextError, the fail-closed error every plan-context module
 * raises.
 *
 * Extraction failure is fatal on purpose. A pattern that stops matching means
 * the source moved; the repair is to fix the extractor, never to inline the
 * value it used to find.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo-relative sources every emitted fact is derived from. */
export const SOURCE_PATHS = {
  checkYml: ".github/workflows/check.yml",
  gitignore: ".gitignore",
  packageJson: "package.json",
  planParser: "packages/workflows/src/plan-meta/parser.ts",
  planSchema: "packages/workflows/src/plan-meta/schema.ts",
  registrar: "packages/cli/src/commands/registrar.ts",
  validator: "packages/workflows/src/plan-meta/validator.ts",
} as const;

export class PlanContextError extends Error {}

export interface ValidatorContext {
  file_scope_new_checked_on_disk: boolean;
  parallel_with_must_be_reciprocal: boolean;
  rules: string[];
  source: string;
}

export interface FormatContext {
  depends_on_id_pattern: string;
  enums: { file_scope: string[]; risk_class: string[]; task_size: string[] };
  heading_clear_prefix: string;
  phase_header_probe: {
    ascii_hyphen: boolean;
    colon: boolean;
    em_dash: boolean;
  };
  phase_header_regex: string;
  qualified_depends_on_id_pattern: string;
  task_heading_prefix: string;
  task_id_accepts_yaml_number: boolean;
}

export interface CiStep {
  blocking: boolean;
  commands: string[];
  name: string;
}

export interface GateContext {
  advisory_commands: string[];
  blocking_commands: string[];
  package_script_expansions: Record<string, string>;
  shard_commands: string[];
  steps: CiStep[];
}

export interface PlanLocationContext {
  dir: string;
  gitignore_line: number | null;
  gitignored: boolean;
  pattern: string | null;
}

export interface RepoSources {
  checkYml: string;
  gitignore: string;
  packageJson: string;
  planParser: string;
  planSchema: string;
  registrar: string;
  validator: string;
}

function requireMatch(source: string, pattern: RegExp, what: string, path: string): string {
  const captured = pattern.exec(source)?.[1];
  if (captured === undefined) {
    throw new PlanContextError(
      `could not extract ${what} from ${path}: the source moved. Fix the extractor in scripts/plan-context-sources.ts; do not inline the value.`,
    );
  }
  return captured;
}

function sliceFunction(source: string, name: string, path: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) {
    throw new PlanContextError(`${path} no longer declares function ${name}`);
  }
  const end = source.indexOf("\n}", start);
  return source.slice(start, end < 0 ? source.length : end);
}

function compileRegexLiteral(literal: string, path: string): RegExp {
  const parsed = /^\/(.*)\/([a-z]*)$/s.exec(literal);
  const body = parsed?.[1];
  const flags = parsed?.[2];
  if (body === undefined || flags === undefined) {
    throw new PlanContextError(`extracted a non-regex literal from ${path}: ${literal}`);
  }
  try {
    return new RegExp(body, flags);
  } catch {
    throw new PlanContextError(`extracted regex from ${path} does not compile: ${literal}`);
  }
}

/** The registrar's phase-header regex, read out of parsePhaseHeaders itself. */
export function extractPhaseHeaderRegex(registrarSource: string): string {
  const body = sliceFunction(registrarSource, "parsePhaseHeaders", SOURCE_PATHS.registrar);
  return requireMatch(
    body,
    /(\/[^\n]*?\/[a-z]*)\.exec\(/,
    "the phase-header regex",
    SOURCE_PATHS.registrar,
  );
}

/**
 * Probe the extracted regex rather than describing it. Which separator a phase
 * header may use is the trap — an unmatched header is dropped from the
 * registrar with no error — and a probe cannot go stale the way prose can.
 */
export function probePhaseHeader(regexLiteral: string): FormatContext["phase_header_probe"] {
  const regex = compileRegexLiteral(regexLiteral, SOURCE_PATHS.registrar);
  const matches = (line: string): boolean => regex.test(line);
  return {
    ascii_hyphen: matches("## Phase 1 - Example"),
    colon: matches("## Phase 1: Example"),
    em_dash: matches("## Phase 1 — Example"),
  };
}

/** The heading prefixes the plan parser reacts to: longest opens, shortest clears. */
export function extractHeadingPrefixes(parserSource: string): {
  clear: string;
  task: string;
} {
  const prefixes = [
    ...new Set(
      [...parserSource.matchAll(/startsWith\("(#{1,6} )"\)/g)]
        .map((match) => match[1])
        .filter((prefix): prefix is string => prefix !== undefined),
    ),
  ].sort((left, right) => right.length - left.length);
  const task = prefixes[0];
  const clear = prefixes.at(-1);
  if (task === undefined || clear === undefined || task === clear) {
    throw new PlanContextError(
      `could not extract the task and section heading prefixes from ${SOURCE_PATHS.planParser}: the parser moved`,
    );
  }
  return { clear, task };
}

function extractEnum(schemaSource: string, name: string): string[] {
  const literal = requireMatch(
    schemaSource,
    new RegExp(`${name}\\s*=\\s*z\\.enum\\(\\[([^\\]]*)\\]\\)`),
    `the ${name} enum`,
    SOURCE_PATHS.planSchema,
  );
  return [...literal.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

type SchemaRules = Pick<
  FormatContext,
  | "depends_on_id_pattern"
  | "enums"
  | "qualified_depends_on_id_pattern"
  | "task_id_accepts_yaml_number"
>;

/** Task-id, dependency and enum rules, read from the plan-meta schema. */
export function extractSchemaRules(schemaSource: string): SchemaRules {
  const bare = requireMatch(
    schemaSource,
    /BareTaskIdSchema\s*=\s*z\.string\(\)\.regex\((\/[^\n]*?\/[a-z]*)\)/,
    "the bare task-id pattern",
    SOURCE_PATHS.planSchema,
  );
  const qualified = requireMatch(
    schemaSource,
    /QualifiedTaskIdSchema\s*=\s*z\.string\(\)\.regex\((\/[^\n]*?\/[a-z]*)\)/,
    "the qualified task-id pattern",
    SOURCE_PATHS.planSchema,
  );
  const taskIdUnion = requireMatch(
    schemaSource,
    /TaskIdSchema\s*=\s*z\.union\(\[([^\]]*)\]\)/,
    "the task-id union",
    SOURCE_PATHS.planSchema,
  );
  return {
    depends_on_id_pattern: bare,
    enums: {
      file_scope: extractEnum(schemaSource, "FileScope"),
      risk_class: extractEnum(schemaSource, "RiskClass"),
      task_size: extractEnum(schemaSource, "TaskSize"),
    },
    qualified_depends_on_id_pattern: qualified,
    task_id_accepts_yaml_number: taskIdUnion.includes("z.number()"),
  };
}

/** Every rule name the plan validator can emit. */
export function extractValidatorRules(validatorSource: string): string[] {
  const rules = [
    ...new Set(
      [...validatorSource.matchAll(/rule:\s*"([a-z_]+)"/g)]
        .map((match) => match[1])
        .filter((rule): rule is string => rule !== undefined),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (rules.length === 0) {
    throw new PlanContextError(
      `no validation rules found in ${SOURCE_PATHS.validator}: the validator moved`,
    );
  }
  return rules;
}

export function buildValidatorContext(validatorSource: string): ValidatorContext {
  const rules = extractValidatorRules(validatorSource);
  return {
    file_scope_new_checked_on_disk: rules.includes("file_already_exists"),
    parallel_with_must_be_reciprocal: rules.includes("parallel_with_not_reciprocal"),
    rules,
    source: SOURCE_PATHS.validator,
  };
}

export function buildFormatContext(
  sources: Pick<RepoSources, "planParser" | "planSchema" | "registrar">,
): FormatContext {
  const phaseHeaderRegex = extractPhaseHeaderRegex(sources.registrar);
  const headings = extractHeadingPrefixes(sources.planParser);
  return {
    ...extractSchemaRules(sources.planSchema),
    heading_clear_prefix: headings.clear,
    phase_header_probe: probePhaseHeader(phaseHeaderRegex),
    phase_header_regex: phaseHeaderRegex,
    task_heading_prefix: headings.task,
  };
}

function parseShellArrays(block: readonly string[]): Map<string, string[]> {
  const arrays = new Map<string, string[]>();
  let name: string | null = null;
  let values: string[] = [];
  for (const line of block) {
    const trimmed = line.trim();
    const opened = /^([A-Za-z_][A-Za-z0-9_]*)=\(\s*$/.exec(trimmed)?.[1];
    if (opened !== undefined) {
      name = opened;
      values = [];
      continue;
    }
    if (name === null) {
      continue;
    }
    if (trimmed === ")") {
      arrays.set(name, values);
      name = null;
    } else if (trimmed.length > 0) {
      values.push(trimmed);
    }
  }
  return arrays;
}

function expandShellArrays(command: string, arrays: ReadonlyMap<string, string[]>): string {
  let expanded = command;
  for (const [name, values] of arrays) {
    const joined = values.join(" ");
    expanded = expanded.replaceAll(`"\${${name}[@]}"`, joined).replaceAll(`\${${name}[@]}`, joined);
  }
  return expanded;
}

function commandFromLine(line: string, arrays: ReadonlyMap<string, string[]>): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("#")) {
    return null;
  }
  const body = trimmed.startsWith("run:") ? trimmed.slice("run:".length).trim() : trimmed;
  if (!body.startsWith("bun ")) {
    return null;
  }
  const head = body.split(" || ")[0] ?? body;
  return expandShellArrays(head.trim(), arrays);
}

function splitStepBlocks(lines: readonly string[]): string[][] {
  const blocks: string[][] = [];
  let itemIndent: number | null = null;
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const isItem = /^\s*- \S/.test(line);
    if (itemIndent === null && isItem) {
      itemIndent = indent;
    }
    if (itemIndent !== null && indent < itemIndent) {
      break;
    }
    if (isItem && indent === itemIndent) {
      current = [];
      blocks.push(current);
    }
    current?.push(line);
  }
  return blocks;
}

function unquote(value: string): string {
  return /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
}

function stepFromBlock(block: readonly string[]): CiStep {
  const arrays = parseShellArrays(block);
  const commands: string[] = [];
  let name = "";
  let blocking = true;
  for (const line of block) {
    const parsedName = /^\s*(?:- )?name:[ \t]*(\S.*)$/.exec(line)?.[1];
    if (parsedName !== undefined && name === "") {
      name = unquote(parsedName.trim());
    }
    if (/^\s*continue-on-error:\s*true\s*$/.test(line)) {
      blocking = false;
    }
    const command = commandFromLine(line, arrays);
    if (command !== null) {
      commands.push(command);
    }
  }
  return { blocking, commands, name };
}

/** The CI job's steps, in order, with shell array references expanded. */
export function parseCiSteps(checkYml: string): CiStep[] {
  const lines = checkYml.split(/\r?\n/);
  const stepsAt = lines.findIndex((line) => /^\s*steps:\s*$/.test(line));
  if (stepsAt < 0) {
    throw new PlanContextError(`${SOURCE_PATHS.checkYml} has no steps: block`);
  }
  const steps = splitStepBlocks(lines.slice(stepsAt + 1)).map((block) => stepFromBlock(block));
  if (steps.length === 0) {
    throw new PlanContextError(`${SOURCE_PATHS.checkYml} declares no steps`);
  }
  return steps;
}

function readPackageScripts(packageJsonText: string): Record<string, string> {
  const parsed: unknown = JSON.parse(packageJsonText);
  const scripts =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["scripts"]
      : undefined;
  if (typeof scripts !== "object" || scripts === null) {
    throw new PlanContextError(`${SOURCE_PATHS.packageJson} has no scripts map`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function scriptExpansions(
  commands: readonly string[],
  scripts: Readonly<Record<string, string>>,
): Record<string, string> {
  const expansions: Record<string, string> = {};
  for (const command of commands) {
    const name = /^bun run ([^\s]+)$/.exec(command)?.[1];
    const expansion = name === undefined ? undefined : scripts[name];
    if (name !== undefined && expansion !== undefined) {
      expansions[name] = expansion;
    }
  }
  return expansions;
}

/**
 * The real gate: CI step order, which steps block, the per-package shard
 * command (root `bun test` is NOT the gate), and what each `bun run <script>`
 * expands to.
 */
export function buildGateContext(checkYml: string, packageJsonText: string): GateContext {
  const steps = parseCiSteps(checkYml).filter((step) => step.commands.length > 0);
  const commands = steps.flatMap((step) => step.commands);
  const shard = commands.filter((command) => command.includes("bun-test-gate.ts"));
  if (shard.length === 0) {
    throw new PlanContextError(
      `no test-shard command found in ${SOURCE_PATHS.checkYml}: the gate moved`,
    );
  }
  return {
    advisory_commands: steps.filter((step) => !step.blocking).flatMap((step) => step.commands),
    blocking_commands: steps.filter((step) => step.blocking).flatMap((step) => step.commands),
    package_script_expansions: scriptExpansions(commands, readPackageScripts(packageJsonText)),
    shard_commands: shard,
    steps,
  };
}

/** Exact-line match against .gitignore, which is all a directory entry needs. */
export function findGitignoreEntry(
  gitignore: string,
  dir: string,
): { line: number; pattern: string } | null {
  const normalized = dir.replace(/^\.\//, "").replace(/\/+$/, "");
  const candidates = new Set([normalized, `${normalized}/`, `/${normalized}`, `/${normalized}/`]);
  for (const [index, raw] of gitignore.split(/\r?\n/).entries()) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      continue;
    }
    if (candidates.has(trimmed)) {
      return { line: index + 1, pattern: trimmed };
    }
  }
  return null;
}

export function buildPlanLocation(gitignore: string, dir: string): PlanLocationContext {
  const entry = findGitignoreEntry(gitignore, dir);
  return {
    dir,
    gitignore_line: entry?.line ?? null,
    gitignored: entry !== null,
    pattern: entry?.pattern ?? null,
  };
}

export function readSources(repoRoot: string): RepoSources {
  const read = (relative: string): string => {
    const absolute = join(repoRoot, relative);
    if (!existsSync(absolute)) {
      throw new PlanContextError(`missing source ${relative} under ${repoRoot}`);
    }
    return readFileSync(absolute, "utf8");
  };
  return {
    checkYml: read(SOURCE_PATHS.checkYml),
    gitignore: read(SOURCE_PATHS.gitignore),
    packageJson: read(SOURCE_PATHS.packageJson),
    planParser: read(SOURCE_PATHS.planParser),
    planSchema: read(SOURCE_PATHS.planSchema),
    registrar: read(SOURCE_PATHS.registrar),
    validator: read(SOURCE_PATHS.validator),
  };
}
