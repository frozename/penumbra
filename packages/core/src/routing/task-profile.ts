import { type AgentTaskType, inferAgentTaskTypeForRole } from "../schemas/agent-performance.js";
import {
  type RoutingTaskType,
  RoutingTaskTypeSchema,
  type TaskProfile,
  TaskProfileSchema,
} from "./schemas.js";

export interface TaskProfileHints {
  taskType?: AgentTaskType;
  taskClass?: string;
  expectedInputTokens?: number;
  expectedOutputTokens?: number;
  requiredCapabilities?: string[];
  preferredCapabilities?: string[];
  disallowedCapabilities?: string[];
  [key: string]: unknown;
}

const TASK_TYPE_ORDER = RoutingTaskTypeSchema.options;

const SIGNALS = {
  coding:
    /\b(?:code|coding|implement|implementation|refactor|typescript|javascript|function|class|api)\b/i,
  debugging: /\b(?:bug|debug|diagnos|failure|failing|fix|regression|root cause|broken)\w*/i,
  review: /\b(?:review|audit|inspect|critique)\w*/i,
  architecture: /\b(?:architect|design|plan|decompos|system boundary)\w*/i,
  agentic: /\b(?:agent|dispatch|workflow|autonom|multi[- ]step|tool call)\w*/i,
  research: /\b(?:research|investigat|compare|evidence|source|literature)\w*/i,
  analysis: /\b(?:analy[sz]|evaluat|assess|reason)\w*/i,
  writing: /\b(?:write|writing|document|docs|readme|copy|format|typo)\w*/i,
  summarization: /\b(?:summari[sz]|summary|digest|condense)\w*/i,
  multimodal: /\b(?:image|screenshot|video|audio|diagram|visual)\w*/i,
  toolUse: /\b(?:run|command|test|check|verify|browse|search|commit|file)\w*/i,
  repoWide:
    /\b(?:repo[- ]wide|across (?:the )?(?:repo|repository|monorepo|codebase)|every package|all packages|multiple packages)\b/i,
  small: /\b(?:one[- ]line|single[- ]line|tiny|trivial|formatting|typo|whitespace)\b/i,
  risk: /\b(?:security|auth|migration|database|schema|production|breaking|delete|payment|billing|permission)\w*/i,
  vague: /\b(?:thing|stuff|something|somehow|whatever)\b/i,
} as const;

type DemandAxes = Pick<
  TaskProfile,
  | "complexity"
  | "risk"
  | "ambiguity"
  | "codingDemand"
  | "reasoningDemand"
  | "agenticDemand"
  | "contextDemand"
  | "latencySensitivity"
  | "costSensitivity"
  | "reliabilityDemand"
>;

export function profileTaskDeterministic(
  message: string,
  role?: string,
  hints: TaskProfileHints = {},
): TaskProfile {
  const legacyTaskType =
    hints.taskType ?? inferAgentTaskTypeForRole(message, role ?? null, undefined);
  const matched = matchSignals(message);
  const taskTypes = deriveTaskTypes(legacyTaskType, matched);
  const axes = deriveAxes(message, legacyTaskType, matched);
  const signalCount = countSignals(legacyTaskType, matched);
  const confidence = signalCount === 0 ? 0.25 : round(Math.min(0.92, 0.46 + signalCount * 0.07));

  return TaskProfileSchema.parse({
    schemaVersion: "1",
    taskTypes,
    ...axes,
    expectedInputTokens: nonNegativeInt(
      hints.expectedInputTokens,
      Math.max(1, Math.ceil(message.length / 4)),
    ),
    expectedOutputTokens: nonNegativeInt(
      hints.expectedOutputTokens,
      Math.round(180 + axes.complexity * 820),
    ),
    requiredCapabilities: stringList(hints.requiredCapabilities),
    preferredCapabilities: stringList(hints.preferredCapabilities),
    disallowedCapabilities: stringList(hints.disallowedCapabilities),
    confidence,
    rationale: deriveRationale(legacyTaskType, matched, signalCount),
  });
}

function matchSignals(message: string): Record<keyof typeof SIGNALS, boolean> {
  return Object.fromEntries(
    Object.entries(SIGNALS).map(([name, pattern]) => [name, pattern.test(message)]),
  ) as Record<keyof typeof SIGNALS, boolean>;
}

function deriveTaskTypes(
  legacyTaskType: AgentTaskType,
  matched: ReturnType<typeof matchSignals>,
): RoutingTaskType[] {
  const selected = new Set<RoutingTaskType>();
  switch (legacyTaskType) {
    case "implement_small":
    case "implement_substantial":
      selected.add("coding");
      break;
    case "review_adversarial":
      selected.add("code_review");
      break;
    case "plan_refine":
      selected.add("architecture");
      selected.add("analysis");
      break;
    case "docs_mechanical":
      selected.add("writing");
      break;
    case "debug_diagnose":
      selected.add("debugging");
      selected.add("analysis");
      break;
    case "smoke_test":
    case "health_check":
      selected.add("tool_use");
      break;
    case "unknown":
      break;
  }

  const signalTypes: [keyof typeof matched, RoutingTaskType][] = [
    ["coding", "coding"],
    ["debugging", "debugging"],
    ["review", "code_review"],
    ["architecture", "architecture"],
    ["agentic", "agentic"],
    ["research", "research"],
    ["analysis", "analysis"],
    ["writing", "writing"],
    ["summarization", "summarization"],
    ["multimodal", "multimodal"],
    ["toolUse", "tool_use"],
  ];
  for (const [signal, taskType] of signalTypes) {
    if (matched[signal]) selected.add(taskType);
  }
  if (selected.size === 0) selected.add("other");

  return TASK_TYPE_ORDER.filter((taskType) => selected.has(taskType));
}

function deriveAxes(
  message: string,
  legacyTaskType: AgentTaskType,
  matched: ReturnType<typeof matchSignals>,
): DemandAxes {
  const axes: DemandAxes = {
    complexity: 0.3,
    risk: 0.2,
    ambiguity: 0.68,
    codingDemand: 0.15,
    reasoningDemand: 0.35,
    agenticDemand: 0.1,
    contextDemand: 0.25,
    latencySensitivity: 0.5,
    costSensitivity: 0.55,
    reliabilityDemand: 0.55,
  };

  applyLegacyTaskTypeAxes(axes, legacyTaskType);
  applySignalAxes(axes, matched, legacyTaskType);

  const hasSpecificSignal = countSpecificSignals(matched) > 0 || legacyTaskType !== "unknown";
  axes.ambiguity = matched.vague || !hasSpecificSignal ? 0.82 : message.length < 30 ? 0.55 : 0.25;
  return mapAxes(axes, round);
}

function applySignalAxes(
  axes: DemandAxes,
  matched: ReturnType<typeof matchSignals>,
  legacyTaskType: AgentTaskType,
): void {
  if (matched.coding) axes.codingDemand = Math.max(axes.codingDemand, 0.78);
  if (matched.debugging) {
    axes.reasoningDemand = Math.max(axes.reasoningDemand, 0.72);
    axes.reliabilityDemand = Math.max(axes.reliabilityDemand, 0.75);
  }
  if (matched.review) {
    axes.reasoningDemand = Math.max(axes.reasoningDemand, 0.72);
    axes.reliabilityDemand = Math.max(axes.reliabilityDemand, 0.82);
  }
  if (matched.architecture || matched.research || matched.analysis) {
    axes.reasoningDemand = Math.max(axes.reasoningDemand, 0.8);
  }
  if (matched.agentic) {
    axes.agenticDemand = 0.85;
    axes.reliabilityDemand = Math.max(axes.reliabilityDemand, 0.78);
  }
  if (matched.multimodal) axes.contextDemand = Math.max(axes.contextDemand, 0.65);
  if (matched.risk) {
    axes.risk = 0.82;
    axes.reliabilityDemand = Math.max(axes.reliabilityDemand, 0.9);
  }
  if (matched.repoWide) applyRepoWideAxes(axes, matched, legacyTaskType);
  if (matched.small && !matched.repoWide) applySmallTaskAxes(axes, matched);
}

function applyRepoWideAxes(
  axes: DemandAxes,
  matched: ReturnType<typeof matchSignals>,
  legacyTaskType: AgentTaskType,
): void {
  axes.complexity = 0.9;
  axes.contextDemand = 0.88;
  axes.reliabilityDemand = Math.max(axes.reliabilityDemand, 0.85);
  if (matched.coding || legacyTaskType.startsWith("implement_")) axes.codingDemand = 0.95;
}

function applySmallTaskAxes(axes: DemandAxes, matched: ReturnType<typeof matchSignals>): void {
  axes.complexity = 0.18;
  axes.risk = matched.risk ? axes.risk : 0.1;
  axes.contextDemand = 0.15;
  axes.reasoningDemand = Math.min(axes.reasoningDemand, 0.3);
  axes.agenticDemand = Math.min(axes.agenticDemand, 0.15);
  axes.latencySensitivity = 0.9;
  axes.costSensitivity = 0.9;
}

function applyLegacyTaskTypeAxes(axes: DemandAxes, taskType: AgentTaskType): void {
  switch (taskType) {
    case "implement_small":
      Object.assign(axes, {
        complexity: 0.25,
        codingDemand: 0.75,
        reasoningDemand: 0.4,
        latencySensitivity: 0.8,
        costSensitivity: 0.8,
        reliabilityDemand: 0.7,
      });
      break;
    case "implement_substantial":
      Object.assign(axes, {
        complexity: 0.72,
        codingDemand: 0.88,
        reasoningDemand: 0.7,
        contextDemand: 0.68,
        latencySensitivity: 0.25,
        costSensitivity: 0.3,
        reliabilityDemand: 0.8,
      });
      break;
    case "review_adversarial":
      Object.assign(axes, {
        complexity: 0.58,
        reasoningDemand: 0.78,
        contextDemand: 0.65,
        reliabilityDemand: 0.88,
      });
      break;
    case "plan_refine":
      Object.assign(axes, {
        complexity: 0.65,
        reasoningDemand: 0.85,
        contextDemand: 0.7,
        reliabilityDemand: 0.78,
      });
      break;
    case "docs_mechanical":
      Object.assign(axes, {
        complexity: 0.22,
        reasoningDemand: 0.3,
        latencySensitivity: 0.75,
        costSensitivity: 0.82,
      });
      break;
    case "debug_diagnose":
      Object.assign(axes, {
        complexity: 0.62,
        codingDemand: 0.45,
        reasoningDemand: 0.82,
        reliabilityDemand: 0.85,
      });
      break;
    case "smoke_test":
    case "health_check":
      Object.assign(axes, {
        complexity: 0.2,
        reasoningDemand: 0.3,
        latencySensitivity: 0.82,
        costSensitivity: 0.82,
        reliabilityDemand: 0.8,
      });
      break;
    case "unknown":
      break;
  }
}

function countSignals(
  legacyTaskType: AgentTaskType,
  matched: ReturnType<typeof matchSignals>,
): number {
  return countSpecificSignals(matched) + (legacyTaskType === "unknown" ? 0 : 1);
}

function countSpecificSignals(matched: ReturnType<typeof matchSignals>): number {
  return [
    matched.coding,
    matched.debugging,
    matched.review,
    matched.architecture,
    matched.agentic,
    matched.research,
    matched.analysis,
    matched.writing,
    matched.summarization,
    matched.multimodal,
    matched.toolUse,
    matched.repoWide,
    matched.small,
    matched.risk,
  ].filter(Boolean).length;
}

function deriveRationale(
  legacyTaskType: AgentTaskType,
  matched: ReturnType<typeof matchSignals>,
  signalCount: number,
): string[] {
  if (signalCount === 0) {
    return ["No recognized task signal; using a conservative low-confidence profile."];
  }
  const rationale: string[] = [];
  if (legacyTaskType !== "unknown") {
    rationale.push(`Legacy task and role signals map to ${legacyTaskType}.`);
  }
  if (matched.repoWide)
    rationale.push("Repository-wide scope raises complexity and context demand.");
  if (matched.small && !matched.repoWide)
    rationale.push("A narrowly scoped mechanical change favors low latency and cost.");
  if (matched.risk) rationale.push("Risk-sensitive terms raise reliability demand.");
  if (matched.agentic) rationale.push("Agent or workflow signals raise agentic demand.");
  if (rationale.length === 0)
    rationale.push("Recognized lexical task signals determine the demand axes.");
  return rationale;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function mapAxes(axes: DemandAxes, transform: (value: number) => number): DemandAxes {
  return Object.fromEntries(
    Object.entries(axes).map(([name, value]) => [name, transform(value)]),
  ) as unknown as DemandAxes;
}

function round(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}
