export { Branding } from './branding.js';
export type { SiriusEmbedderOpts } from './embedder/sirius.js';
export { SettingsDefaults, SettingsSchema, type Settings, type SettingsInput } from './settings.js';
export { systemClock, type Clock } from './utils/clock.js';
export { systemUuid, type Uuid } from './utils/uuid.js';
export { RegexRedactor, DEFAULT_REDACTION_RULES, type RedactionRule } from './redaction/regex.js';
export { stripPrivacyTags } from './redaction/privacy-tags.js';
export {
  MAX_WALKER_DEPTH,
  MAX_WALKER_STRING_BYTES,
  WALKER_DEPTH_EXCEEDED_RULE_ID,
  WALKER_STRING_OVERSIZE_RULE_ID,
  ValuePatternRedactor,
  type ValuePatternRule,
  type ValueRedactionHit,
  type RedactStringResult,
  type RedactValueLimits,
  type RedactValueResult,
} from './redaction/value-patterns.js';
export { MachineId } from './identity/machine-id.js';
export { createLogger, type Logger } from './logger.js';
export { normalize, type NormalizeCtx } from './normalize/ingest.js';
export {
  T0EventSchema, T0EventInputSchema, type T0Event, type T0EventInput,
  TASK_DRAFT_LIFECYCLE_EVENT_TYPES,
  type TaskDraftLifecycleEventType,
} from './schemas/event.js';
export {
  TaskDraftPayloadSchema,
  TaskDraftProvenanceSchema,
  TaskDraftRefiningPayloadSchema,
  TaskDraftPromotedPayloadSchema,
  TaskDraftStalePayloadSchema,
  TaskDraftDuplicatePayloadSchema,
  TaskDraftEscalationPayloadSchema,
  TaskDraftLifecyclePayloadSchema,
  type TaskDraftPayload,
  type TaskDraftProvenance,
  type TaskDraftRefiningPayload,
  type TaskDraftPromotedPayload,
  type TaskDraftStalePayload,
  type TaskDraftDuplicatePayload,
  type TaskDraftEscalationPayload,
  type TaskDraftLifecyclePayload,
  type ParsedTaskDraftLifecyclePayload,
  parseTaskDraftLifecyclePayload,
} from './schemas/task-draft.js';
export { buildServices, type Services, type BuildServicesOpts, type Watchdog, type AgentRoutingConfig } from './services.js';
export { type McpPoolLike, type ActionGateLike } from './services.js';
export { resolveProjectScope, type ProjectScope } from './identity/project-resolver.js';
export type {
  WorkflowRegistry,
  RegistryEntry,
  RegistryError,
  BuildRegistryOpts,
} from './workflows/registry-interface.js';
export { loadSqliteVec } from './db/sqlite-vec.js';
export { applySchema, SCHEMA_VERSION } from './db/schema.js';
export { migrate, type MigrateOpts } from './db/migrations.js';
export { backfillRecallFields, type BackfillStats } from './db/backfill-recall-fields.js';
export {
  closeLane,
  getLane,
  insertLane,
  recentLanes,
  type CloseLaneInput,
  type InsertLaneInput,
  type LaneGateStatus,
  type LaneRow,
  type RecentLaneFilter,
} from './db/lane-ledger.js';
export type { Embedder } from './embedder/interface.js';
export { BundledEmbedder } from './embedder/bundled.js';
export { SiriusEmbedder } from './embedder/sirius.js';
export { resolveEmbedder } from './embedder/resolve.js';
export {
  RecallRequestSchema,
  RecallResultSchema,
  STALE_AFTER_DAYS_DEFAULT,
  STALE_AFTER_DAYS_BY_OBS_TYPE,
  STALE_AFTER_DAYS,
  type RecallRequest,
  type RecallResult,
  staleThresholdDays,
  SearchRequestSchema,
  TimelineRequestSchema,
  GetObservationsRequestSchema,
  type SearchRequest,
  type SearchHit,
  type TimelineRequest,
  type TimelineEntry,
  type GetObservationsRequest,
  type ObservationDetail,
  CorpusFilterSchema,
  CorpusBuildRequestSchema,
  CorpusQueryRequestSchema,
  CorpusSummarySchema,
  type CorpusFilterInput,
  type CorpusBuildRequest,
  type CorpusQueryRequest,
  type CorpusSummaryRow,
} from './schemas/recall.js';
export { search } from './readers/search.js';
export { timeline } from './readers/timeline.js';
export { getMemoryVerificationEvents, type MemoryVerificationEvent } from './readers/memory-verification-events.js';
export { getObservations } from './readers/get-observations.js';
export { TaskDraftReader, type PendingTaskDraft, type PendingTaskDraftEscalation, type ListPendingInput, type ListPendingEscalationsInput } from './readers/task-draft.js';
export { recallStatus, type RecallStatus } from './readers/recall-status.js';
export { qualityStatus, type QualityStatusSnapshot, type QualityStatusInput } from './readers/quality-status.js';
export { routeAgent, type DetailMode, type RouteAgentInput, type RouteAgentOutput, type RoleRoute, type AgentRecommendation } from './services/agent-routing.js';
export { extractStumblesFromSession, type StumbleCandidate, type ExtractStumblesInput, type StumbleEvidence } from './services/stumble-extractor.js';
export {
  buildCorpus,
  listCorpora,
  queryCorpus,
  removeCorpus,
  type CorpusFilter,
  type BuildCorpusInput,
  type CorpusSummary,
} from './readers/corpus.js';
export { T1Rollup, type T1RollupOpts } from './writers/t1.js';
export { T2Promotion, type T2PromotionOpts, type LLMJudge, type T2MemoryExtraction, verifyMemory } from './writers/t2.js';
export { PidRegistry } from './pid/registry.js';
export { InProcessSupervisor } from './supervisor/in-process.js';
export { resolveProjectId } from './identity/project-id.js';
export { ProjectRegistry, loadProjectRegistry, defaultProjectRegistryPath, ProjectRegistryParseError, ProjectRegistryDuplicateId } from './projects/registry.js';
export { findProjectIdByCwd } from './projects/registry-cwd.js';
export type { ProjectEntry, ProjectRegistryFile } from './projects/schema.js';
export { ContextFileWriter, type ContextFileWriterOpts } from './context-file/writer.js';
export { derivePlanId } from './plans/plan-id.js';
export { SafeProjectIdSchema, assertSafeProjectId } from './schemas/project-id.js';
export {
  HandoffStatusSchema,
  HandoffRowSchema,
  CreateHandoffRequestSchema,
  ApproveHandoffRequestSchema,
  type HandoffStatus,
  type HandoffRow,
  type CreateHandoffRequest,
  type ApproveHandoffRequest,
} from './schemas/handoff.js';
export {
  HandoffWriter,
  type CreateHandoffParams, type CreateApprovedParams,
  type ApproveOpts, type ApproveResult,
} from './writers/handoff.js';
export { HandoffReader, type HandoffReaderOpts } from './readers/handoff.js';
export {
  recentCost,
  readRecentSubscriptionPressureSnapshots,
  collectSubscriptionPressure,
  type RecentCostInput,
  type RecentCostOutput,
  type SubscriptionPressureRow,
  type SubscriptionPressureSnapshot,
} from './readers/cost.js';
export { quotaStatus, type ProviderQuota, type QuotaStatusInput, type QuotaStatusOutput, type QuotaStatusProviderRow } from './readers/cost-quota.js';
export { readSubscriptionPressure, type PressureSnapshot, type PressureWarning, type PressureResult, type ReadSubscriptionPressureOpts } from './readers/subscription-pressure.js';
export {
  createSubscriptionPressureCache,
  type SubscriptionPressureCache,
  type SubscriptionPressureCacheOptions,
} from './maestro/subscription-pressure-cache.js';
export {
  checkPressureCap,
  type CapCheckOutcome,
  type CapCheckPass,
  type CapCheckWarn,
  type CapCheckRefuse,
  type CheckPressureCapDeps,
  type WindowCaps,
  type ProviderCaps,
} from './maestro/check-pressure-cap.js';
export { ChainReader, type ChainTerminatedEvent, type AgentResponseEvent, type ChainSummary } from './readers/chain.js';
export { HandoffEventBus, type HandoffEventListener } from './events/handoff-events.js';
export { ConversationStreamBus, type ConversationStreamListener } from './events/conversation-stream.js';
export { WorkerControlBus, type WorkerControlListener } from './events/worker-control.js';
export { ChainStartRequestSchema, type ChainStartRequest } from './schemas/chain.js';
export { TaskClassSchema, type TaskClass } from './schemas/task-class.js';
export { LaneCloseMetadataSchema, LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES, type LaneCloseMetadata } from './schemas/lane-close-metadata.js';
export { T1RollupSchema, type T1RollupRow } from './schemas/rollup.js';
export { T2MemorySchema, type T2MemoryRow } from './schemas/memory.js';
export * from './schemas/sse-events.js';
export * from './schemas/sse.js';
export * from './schemas/write-tools-events.js';
export { resolveDaemonStorageRoot, waitForDaemonStorageRoot, type ResolveDaemonStorageRootOpts, type WaitForDaemonStorageRootOpts } from './daemon-discovery.js';
export { WorktreeManager, type WorktreeHandle } from './worktree/manager.js';
export {
  PermissionStatusSchema,
  PermissionRememberSchema,
  PermissionRequestRowSchema,
  CreatePermissionRequestSchema,
  ApprovePermissionRequestSchema,
  type PermissionStatus,
  type PermissionRemember,
  type PermissionRequestRow,
  type CreatePermissionRequest,
  type ApprovePermissionRequest,
} from './schemas/permission.js';
export {
  TaskKindSchema,
  BoundsInputSchema,
  TaskPrioritySchema,
  TaskStatusSchema,
  GhCreateStatusSchema,
  TaskEventKindSchema,
  EligibilitySchema,
  ExpectedArtifactSchema,
  ReviewVerdictSchema,
  FileTaskInputSchema,
  LeaseTaskInputSchema,
  HeartbeatTaskInputSchema,
  CompleteTaskInputSchema,
  FailTaskInputSchema,
  CancelTaskInputSchema,
  TaskRecordSchema,
  type TaskKind,
  type BoundsInput,
  type TaskPriority,
  type TaskStatus,
  type GhCreateStatus,
  type TaskEventKind,
  type Eligibility,
  type ExpectedArtifact,
  type ReviewVerdict,
  type FileTaskInput,
  type LeaseTaskInput,
  type HeartbeatTaskInput,
  type CompleteTaskInput,
  type FailTaskInput,
  type CancelTaskInput,
  type TaskRecord,
} from './tasks/schema.js';
export {
  MaestroTerminationReason,
  BoundsAxis,
  MaestroSessionRecord,
} from './maestro/schema.js';
export type { BoundsConsumed } from './maestro/schema.js';
export {
  MaestroSessionWriter,
  MaestroSessionAlreadyDispatched,
  MaestroSessionExists,
  type MaestroSessionWriterOpts,
  type StartMaestroSessionParams,
} from './maestro/writer.js';
export { synthesizeMaestroPrompt, type MaestroPromptBounds } from './maestro/prompt.js';
export {
  PlanWriter,
  PlanAlreadyRegistered,
  PlanNotFound,
  PlanTaskNotFound,
  type RegisterPlanInput,
} from './plans/writer.js';
export {
  PlanRecordSchema,
  PlanStatusSchema,
  PlanTaskRecordSchema,
  PlanTaskStatusSchema,
  type PlanRecord,
  type PlanStatus,
  type PlanTaskRecord,
  type PlanTaskStatus,
} from './plans/schema.js';
export { TaskEventBus, type TaskEvent } from './tasks/event-bus.js';
export {
  TaskWriter,
  TaskNotFound,
  InvalidTaskStatus,
  LeaseConflict,
  LeaseInvalid,
  MissingReviewVerdict,
  UnexpectedReviewVerdict,
  ReviewParentInvalidState,
  type TaskInclude,
  type TaskWithIncludes,
  type TaskLeaseRow,
  type TaskEventRow,
  type TaskDescendants,
  type ListFilters,
} from './tasks/writer.js';
export { TaskReader } from './tasks/reader.js';
export { TaskCooldowns } from './tasks/cooldowns.js';
export { mapTaskEventToLedger, ledgerWriteToPerformanceRow } from './tasks/ledger-bridge.js';
export { EmitCapExceeded } from './tasks/emit-caps.js';
export {
  REVIEW_PROMPT_TEMPLATE,
  mergeDeny,
  synthesizeReviewTask,
} from './tasks/review-pairing.js';
export {
  isEligible,
  TIER_ORDER,
  type AgentDescriptor,
} from './tasks/eligibility.js';
export {
  validateOrchestrateFile,
  OrchestrateRequiresAllowAgents,
  OrchestrateAgentNotMaestroCapable,
  OrchestrateRecursionForbidden,
} from './tasks/orchestrate-validation.js';
export {
  PermissionWriter,
  type PermissionWriterOpts,
  type CreatePermissionInput,
  type DecidePermissionInput,
} from './writers/permission.js';
export { PermissionReader, type PermissionReaderOpts } from './readers/permission.js';
export {
  PermissionEventBus,
  type PermissionEvent,
  type EmittedPermissionEvent,
  type PermissionEventKind,
  type PermissionEventListener,
} from './events/permission-events.js';
export { parseOtlpLogs } from './otlp/parse.js';
export { parseOtlpLogsProtobuf } from './otlp/protobuf.js';
export { normalizeOtlpLogsToUsageEvents, mapProvider } from './otlp/normalize.js';
export type { ParsedLogRecord } from './otlp/types.js';

import { resolveInsideWorktree, FsPathError } from './fs-paths.js';
export { resolveInsideWorktree, FsPathError };

export * from './schemas/agent-performance.js';
export * from './schemas/agent-recommend.js';
export { AgentPerformanceWriter } from './writers/agent-performance.js';
export { aggregateHandoffUsage, captureAgentPerformanceFromDispatch, captureAgentPerformanceFromReconciler } from './services/agent-performance-capture.js';
export { parseAgentPerformanceMarkdownRows, renderAgentPerformanceMarkdown } from './services/agent-performance-markdown.js';
export { recordOperatorAgentPerformance } from './services/agent-performance-operator.js';
export {
  DispatchEventLog,
  type DispatchEventInput,
  type DispatchEventKind,
  type DispatchEventRow,
} from './services/dispatch-event-log.js';
export { DispatchEventBus, type DispatchEvent } from './dispatch/event-bus.js';
export {
  classifyDispatchReliability,
  type DispatchReliabilityEvent,
  type DispatchReliabilityHandoff,
  type DispatchReliabilityInput,
  type DispatchReliabilityReport,
  type DispatchReliabilityStatus,
  type DispatchRecommendedAction,
} from './services/dispatch-reliability.js';
export { type SiriusChatFn, createSiriusChat } from './services/sirius-chat.js';
export {
  refineDispatchPrompt,
  RefineError,
  REFINER_INPUT_MAX_BYTES,
  REFINER_OUTPUT_MAX_BYTES,
  type RefineDispatchPromptOpts,
  type RefineErrorCode,
} from './services/dispatch-prompt-refiner.js';
export { classifyFindings, type Finding, type Classification } from './services/memory-efficacy-classifier.js';
export {
  getMemoryEfficacyRecent,
  buildMemoryEfficacyCache,
  type MemoryEfficacyRecent,
} from './readers/memory-efficacy.js';
export {
  enqueueMemoryEfficacyJob,
  claimNextJob,
  heartbeatJob,
  sweepStaleJobs,
  completeJob,
  getJobStatus,
  listRecentJobs,
  type MemoryEfficacyJobRow,
} from './readers/memory-efficacy-jobs.js';
