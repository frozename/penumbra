import type { z } from "zod";

import { GitShaSchema, RelPathSchema } from "../eval-primitives.js";
import {
  allocateBudget,
  type BudgetAllocation,
  type BudgetItem,
  type BudgetLimits,
  type DroppedItem,
  type TokenCounter,
} from "./budget.js";
import {
  ADVISORY_HEADER,
  type AdvisoryKind,
  renderAdvisoryItem,
  renderAuthoritativeSection,
  renderLastErrorSection,
  renderTokenReportLine,
  SHED_ORDER,
} from "./render.js";
import {
  type AdvisoryItem,
  type ArtifactHandle,
  type Capsule,
  type CapsuleRefusal,
  CapsuleSchema,
  type CheckRecipe,
  type EssentialConstraint,
  type LastError,
  refusal,
  type Tool,
} from "./schema.js";

export interface GitPort {
  readonly headSha: () => Promise<string | null>;
  readonly resolveSha: (ref: string) => Promise<string | null>;
  readonly isAncestor: (ancestor: string, descendant: string) => Promise<boolean | null>;
}

export const PRIVILEGE_KEYS = ["write_fence", "tools", "grants"] as const;

export interface CompileInput {
  readonly objective: string;
  readonly acceptance_state: string;
  readonly base_sha: string;
  readonly dependencies: readonly string[];
  readonly write_fence: readonly string[];
  readonly essential_constraints: readonly EssentialConstraint[];
  readonly check_recipes: readonly CheckRecipe[];
  readonly tool_ids: readonly string[];
  readonly registry: readonly Tool[];
  readonly artifact_handles: readonly ArtifactHandle[];
  readonly advisory: {
    readonly memory: readonly AdvisoryItem[];
    readonly repo_map?: AdvisoryItem;
    readonly log_excerpts: readonly AdvisoryItem[];
  };
  readonly last_error?: LastError;
}

export interface CompileOptions {
  readonly git: GitPort;
  readonly budget: BudgetLimits;
  readonly counter?: TokenCounter;
}

export interface CompileSuccess {
  ok: true;
  capsule: Capsule;
  dropped: DroppedItem[];
}

export type CompileResult = CompileSuccess | CapsuleRefusal;

type Guard = CapsuleRefusal | null;
type AdvisorySource = { kind: AdvisoryKind; item: AdvisoryItem };

function privilegeKeyCarried(item: AdvisoryItem): string | null {
  for (const key of PRIVILEGE_KEYS) {
    if (Object.hasOwn(item, key)) {
      return key;
    }
  }
  const authority: string = item.authority;
  return authority !== "advisory" ? "authority" : null;
}

function advisorySources(advisory: CompileInput["advisory"]): AdvisorySource[] {
  const sources: AdvisorySource[] = [];
  if (advisory.repo_map !== undefined) {
    sources.push({ kind: "repo_map", item: advisory.repo_map });
  }
  for (const item of advisory.memory) {
    sources.push({ kind: "memory", item });
  }
  for (const item of advisory.log_excerpts) {
    sources.push({ kind: "log_excerpts", item });
  }
  return sources;
}

function checkAdvisoryPrivileges(advisory: CompileInput["advisory"]): Guard {
  for (const { kind, item } of advisorySources(advisory)) {
    const key = privilegeKeyCarried(item);
    if (key !== null) {
      return refusal("advisory_privilege_attempt", `${kind}:${item.id} carries ${key}`);
    }
  }
  return null;
}

function checkFence(writeFence: readonly string[]): Guard {
  for (const entry of writeFence) {
    if (!RelPathSchema.safeParse(entry).success) {
      return refusal("fence_violation", entry);
    }
  }
  return null;
}

async function checkBase(baseSha: string, git: GitPort): Promise<Guard> {
  if (!GitShaSchema.safeParse(baseSha).success) {
    return refusal("stale_base", `base_sha ${baseSha} is not a canonical sha`);
  }
  let head: string | null = null;
  try {
    head = await git.headSha();
  } catch {
    head = null;
  }
  if (head === null || head !== baseSha) {
    return refusal("stale_base", `HEAD ${head ?? "unknown"} does not match base_sha ${baseSha}`);
  }
  return null;
}

async function resolveDependencyShas(
  dependencies: readonly string[],
  baseSha: string,
  git: GitPort,
): Promise<{ ok: true; shas: string[] } | CapsuleRefusal> {
  const shas: string[] = [];
  for (const ref of dependencies) {
    let sha: string | null = null;
    try {
      sha = await git.resolveSha(ref);
    } catch {
      sha = null;
    }
    if (sha === null || !GitShaSchema.safeParse(sha).success) {
      return refusal("missing_dependency", `dependency ref ${ref} did not resolve to a sha`);
    }
    let ancestor: boolean | null = null;
    try {
      ancestor = await git.isAncestor(sha, baseSha);
    } catch {
      ancestor = null;
    }
    if (ancestor !== true) {
      return refusal("missing_dependency", `dependency ${ref} is not an ancestor of base`);
    }
    shas.push(sha);
  }
  return { ok: true, shas };
}

function resolveTools(
  toolIds: readonly string[],
  registry: readonly Tool[],
): { ok: true; tools: Tool[] } | CapsuleRefusal {
  const byId = new Map(registry.map((tool) => [tool.id, tool]));
  const tools: Tool[] = [];
  for (const id of toolIds) {
    const entry = byId.get(id);
    if (entry === undefined) {
      return refusal("ref_unresolved", `tool id ${id} is not present in the registry`);
    }
    tools.push(entry);
  }
  return { ok: true, tools };
}

function buildLane(
  input: CompileInput,
  dependencyShas: readonly string[],
  tools: readonly Tool[],
): AuthoritativeLaneShape {
  return {
    objective: input.objective,
    acceptance_state: input.acceptance_state,
    base_sha: input.base_sha,
    base_sha_verified: true,
    dependency_shas: [...dependencyShas],
    write_fence: [...input.write_fence],
    essential_constraints: [...input.essential_constraints],
    check_recipes: [...input.check_recipes],
    tools: [...tools],
    artifact_handles: [...input.artifact_handles],
  };
}

type AuthoritativeLaneShape = Capsule["authoritative"];

function buildBudgetItems(
  lane: AuthoritativeLaneShape,
  lastError: LastError | undefined,
  budget: BudgetLimits,
  sources: readonly AdvisorySource[],
): BudgetItem[] {
  const items: BudgetItem[] = [
    {
      id: "authoritative",
      text: `${renderAuthoritativeSection(lane)}\n`,
      essential: true,
      priority: 0,
    },
  ];
  if (lastError !== undefined) {
    items.push({
      id: "last_error",
      text: `${renderLastErrorSection(lastError)}\n`,
      essential: true,
      priority: 0,
    });
  }
  const frameReport = renderTokenReportLine({
    estimator: "fallback_estimate",
    used: budget.limit,
    limit: budget.limit,
  });
  items.push({
    id: "frame",
    text: `${ADVISORY_HEADER}\n${frameReport}\n`,
    essential: true,
    priority: 0,
  });
  for (const { kind, item } of sources) {
    items.push({
      id: `advisory:${kind}:${item.id}`,
      text: `${renderAdvisoryItem(kind, item)}\n`,
      essential: false,
      priority: SHED_ORDER.length - 1 - SHED_ORDER.indexOf(kind),
    });
  }
  return items;
}

function shedIndexOf(id: string): number {
  const [scope, kind] = id.split(":");
  return scope === "advisory" ? SHED_ORDER.indexOf(kind as AdvisoryKind) : -1;
}

const byShedThenId = (a: DroppedItem, b: DroppedItem): number => {
  const diff = shedIndexOf(a.id) - shedIndexOf(b.id);
  if (diff !== 0) {
    return diff;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

function enforceClassOrder(allocation: BudgetAllocation): { dropped: DroppedItem[]; used: number } {
  let highestDropped = -1;
  for (const dropped of allocation.dropped) {
    highestDropped = Math.max(highestDropped, shedIndexOf(dropped.id));
  }
  const demoted: DroppedItem[] = [];
  let used = allocation.used;
  for (const admitted of allocation.admitted) {
    if (!admitted.essential && shedIndexOf(admitted.id) < highestDropped) {
      demoted.push({ id: admitted.id, tokens: admitted.tokens, reason: "budget" });
      used -= admitted.tokens;
    }
  }
  return { dropped: [...allocation.dropped, ...demoted].toSorted(byShedThenId), used };
}

function assembleCapsule(
  input: CompileInput,
  lane: AuthoritativeLaneShape,
  admittedIds: ReadonlySet<string>,
  tokenReport: Capsule["token_report"],
): Capsule {
  const repoMap = input.advisory.repo_map;
  return {
    schema_version: 1,
    authoritative: lane,
    advisory: {
      memory: input.advisory.memory
        .filter((item) => admittedIds.has(`advisory:memory:${item.id}`))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      ...(repoMap !== undefined && admittedIds.has(`advisory:repo_map:${repoMap.id}`)
        ? { repo_map: repoMap }
        : {}),
      log_excerpts: input.advisory.log_excerpts
        .filter((item) => admittedIds.has(`advisory:log_excerpts:${item.id}`))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    },
    ...(input.last_error === undefined ? {} : { last_error: input.last_error }),
    token_report: tokenReport,
  };
}

function schemaRefusal(error: z.ZodError): CapsuleRefusal {
  const [issue] = error.issues;
  const path = issue === undefined ? "" : issue.path.join(".");
  const message = issue === undefined ? "unknown schema failure" : issue.message;
  const detail = `schema: ${path}: ${message}`;
  if (path.includes("write_fence")) {
    return refusal("fence_violation", detail);
  }
  if (path.includes("base_sha")) {
    return refusal("stale_base", detail);
  }
  if (path.includes("dependency_shas")) {
    return refusal("missing_dependency", detail);
  }
  return refusal("ref_unresolved", detail);
}

export async function compileCapsule(
  input: CompileInput,
  options: CompileOptions,
): Promise<CompileResult> {
  const privilege = checkAdvisoryPrivileges(input.advisory);
  if (privilege !== null) {
    return privilege;
  }
  const fence = checkFence(input.write_fence);
  if (fence !== null) {
    return fence;
  }
  const base = await checkBase(input.base_sha, options.git);
  if (base !== null) {
    return base;
  }
  const dependencies = await resolveDependencyShas(input.dependencies, input.base_sha, options.git);
  if (!dependencies.ok) {
    return dependencies;
  }
  const tools = resolveTools(input.tool_ids, input.registry);
  if (!tools.ok) {
    return tools;
  }
  const lane = buildLane(input, dependencies.shas, tools.tools);
  const items = buildBudgetItems(
    lane,
    input.last_error,
    options.budget,
    advisorySources(input.advisory),
  );
  const allocation = allocateBudget(
    options.counter === undefined
      ? { limits: options.budget, items }
      : { limits: options.budget, items, counter: options.counter },
  );
  if (!allocation.ok) {
    return allocation;
  }
  const shed = enforceClassOrder(allocation);
  const droppedIds = new Set(shed.dropped.map((dropped) => dropped.id));
  const admittedIds = new Set(
    allocation.admitted
      .filter((admitted) => !admitted.essential && !droppedIds.has(admitted.id))
      .map((admitted) => admitted.id),
  );
  const capsule = assembleCapsule(input, lane, admittedIds, {
    estimator: allocation.estimator,
    used: shed.used,
    limit: options.budget.limit,
  });
  const parsed = CapsuleSchema.safeParse(capsule);
  if (!parsed.success) {
    return schemaRefusal(parsed.error);
  }
  return { ok: true, capsule, dropped: shed.dropped };
}
