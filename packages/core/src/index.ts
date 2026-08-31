import { FsPathError, resolveInsideWorktree } from "./fs-paths.js";

export {
  type IssueArgs,
  type IssueResult,
  type WorkerTokenRow,
  WorkerTokenStore,
} from "./auth/worker-token-store.js";
export { Branding } from "./branding.js";
export { ContextFileWriter, type ContextFileWriterOpts } from "./context-file/writer.js";
export {
  type GlobalCrashHandlerOpts,
  installGlobalCrashHandlers,
  type WorkerFatalRecord,
} from "./crash-guard.js";
export {
  resolveDaemonStorageRoot,
  type ResolveDaemonStorageRootOpts,
  waitForDaemonStorageRoot,
  type WaitForDaemonStorageRootOpts,
} from "./daemon-discovery.js";
export { backfillRecallFields, type BackfillStats } from "./db/backfill-recall-fields.js";
export {
  checkEmbeddingModelVersion,
  readStoredEmbeddingModelVersion,
} from "./db/embedding-version-guard.js";
export { getHandoffToAgent } from "./db/handoffs.js";
export {
  type ClosedLaneGateStatus,
  closeLane,
  type CloseLaneInput,
  getClosedLaneRoundCountForHandoffLineage,
  getLane,
  getOpenLaneForImplementer,
  insertLane,
  type InsertLaneInput,
  type LaneGateStatus,
  type LaneRow,
  type RecentLaneFilter,
  recentLanes,
  stampAgentPerformanceGateOutcome,
  stampAgentPerformanceGateOutcomeForHandoff,
} from "./db/lane-ledger.js";
export {
  assertEmbedderDim,
  assertSchemaNotNewer,
  migrate,
  type MigrateOpts,
} from "./db/migrations.js";
export {
  applySchema,
  releaseT1RollupClaims,
  type ReleaseT1RollupClaimsOpts,
  runStartupZombieSweep,
  SCHEMA_VERSION,
} from "./db/schema.js";
export { applyRuntimePragmas, loadSqliteVec } from "./db/sqlite-vec.js";
export {
  assertTestDbPathIsolation,
  resolveStorageDbPath,
  type ResolveStorageDbPathOpts,
} from "./db/storage-db-path.js";
export { type DispatchEvent, DispatchEventBus } from "./dispatch/event-bus.js";
export { BundledEmbedder } from "./embedder/bundled.js";
export type { Embedder } from "./embedder/interface.js";
export type { RemoteEmbedderOpts } from "./embedder/openai-compat.js";
export { OpenAICompatEmbedder } from "./embedder/openai-compat.js";
export { resolveEmbedder } from "./embedder/resolve.js";
export type { EmbedderMode } from "./embedder/resolve.js";
export {
  ConversationStreamBus,
  type ConversationStreamListener,
} from "./events/conversation-stream.js";
export { HandoffEventBus, type HandoffEventListener } from "./events/handoff-events.js";
export {
  HandoffTransitionBus,
  type HandoffTransitionEvent,
  type HandoffTransitionListener,
  type LeftDispatchedEvent,
  type LeftDispatchedToStatus,
} from "./events/handoff-transitions.js";
export {
  type EmittedPermissionEvent,
  type PermissionEvent,
  PermissionEventBus,
  type PermissionEventKind,
  type PermissionEventListener,
} from "./events/permission-events.js";
export { WorkerControlBus, type WorkerControlListener } from "./events/worker-control.js";
export { MachineId } from "./identity/machine-id.js";
export { resolveProjectId } from "./identity/project-id.js";
export { type ProjectScope, resolveProjectScope } from "./identity/project-resolver.js";
export { createLogger, type Logger } from "./logger.js";
export {
  listLongLivedPendingActionsForAgent,
  type LongLivedAgentStateUpdate,
  type LongLivedPendingActionRow,
  readLongLivedAgentWorkingMemory,
  updateLongLivedAgentState,
} from "./long-lived/self-reader.js";
export { type WorkingMemory, WorkingMemorySchema } from "./long-lived/types.js";
export {
  type CapCheckOutcome,
  type CapCheckPass,
  type CapCheckRefuse,
  type CapCheckWarn,
  checkPressureCap,
  type CheckPressureCapDeps,
  type ProviderCaps,
  type WindowCaps,
} from "./maestro/check-pressure-cap.js";
export { type MaestroPromptBounds, synthesizeMaestroPrompt } from "./maestro/prompt.js";
export { BoundsAxis, MaestroSessionRecord, MaestroTerminationReason } from "./maestro/schema.js";
export type { BoundsConsumed } from "./maestro/schema.js";
export {
  createSubscriptionPressureCache,
  type SubscriptionPressureCache,
  type SubscriptionPressureCacheOptions,
} from "./maestro/subscription-pressure-cache.js";
export {
  MaestroSessionAlreadyDispatched,
  MaestroSessionExists,
  MaestroSessionWriter,
  type MaestroSessionWriterOpts,
  type StartMaestroSessionParams,
} from "./maestro/writer.js";
export { type Basis, BasisSchema, validateBasis } from "./memory-verify/basis.js";
export {
  MemoryVerifyAuthorizeInputShape,
  MemoryVerifyClaimInputShape,
} from "./memory-verify/schemas.js";
export { normalize, type NormalizeCtx } from "./normalize/ingest.js";
export { mapProvider, normalizeOtlpLogsToUsageEvents } from "./otlp/normalize.js";
export { parseOtlpLogs } from "./otlp/parse.js";
export { parseOtlpLogsProtobuf } from "./otlp/protobuf.js";
export type { ParsedLogRecord } from "./otlp/types.js";
export { PidRegistry } from "./pid/registry.js";
export { derivePlanId } from "./plans/plan-id.js";
export {
  type PlanRecord,
  PlanRecordSchema,
  type PlanStatus,
  PlanStatusSchema,
  type PlanTaskRecord,
  PlanTaskRecordSchema,
  type PlanTaskStatus,
  PlanTaskStatusSchema,
} from "./plans/schema.js";
export {
  PlanAlreadyRegistered,
  PlanNotFound,
  PlanTaskNotFound,
  PlanWriter,
  type RegisterPlanInput,
} from "./plans/writer.js";
export { findProjectIdByCwd } from "./projects/registry-cwd.js";
export {
  defaultProjectRegistryPath,
  loadProjectRegistry,
  ProjectRegistry,
  ProjectRegistryDuplicateId,
  ProjectRegistryParseError,
} from "./projects/registry.js";
export { getGithubRepo } from "./projects/schema.js";
export type { ProjectEntry, ProjectRegistryFile } from "./projects/schema.js";
export {
  type AgentResponseEvent,
  ChainReader,
  type ChainSummary,
  type ChainTerminatedEvent,
} from "./readers/chain.js";
export {
  buildCorpus,
  type BuildCorpusInput,
  type CorpusFilter,
  type CorpusSummary,
  listCorpora,
  queryCorpus,
  removeCorpus,
} from "./readers/corpus.js";
export {
  KNOWN_PRESSURE_WINDOW_LABELS,
  type KnownPressureWindowLabel,
  type ProviderQuota,
  quotaStatus,
  type QuotaStatusInput,
  type QuotaStatusOutput,
  type QuotaStatusProviderRow,
} from "./readers/cost-quota.js";
export {
  collectSubscriptionPressure,
  readRecentSubscriptionPressureSnapshots,
  recentCost,
  type RecentCostInput,
  type RecentCostOutput,
  type SubscriptionPressureRow,
  type SubscriptionPressureSnapshot,
} from "./readers/cost.js";
export {
  type FleetLatencyAgentRow,
  type FleetLatencyInput,
  type FleetLatencyOutput,
  readFleetLatency,
} from "./readers/fleet-latency.js";
export { getObservations } from "./readers/get-observations.js";
export { HandoffReader, type HandoffReaderOpts } from "./readers/handoff.js";
export {
  claimNextJob,
  completeJob,
  enqueueMemoryEfficacyJob,
  getJobStatus,
  heartbeatJob,
  listRecentJobs,
  type MemoryEfficacyJobRow,
  sweepStaleJobs,
} from "./readers/memory-efficacy-jobs.js";
export {
  buildMemoryEfficacyCache,
  getMemoryEfficacyRecent,
  type MemoryEfficacyRecent,
} from "./readers/memory-efficacy.js";
export {
  getMemoryVerificationEvents,
  type MemoryVerificationEvent,
} from "./readers/memory-verification-events.js";
export { PermissionReader, type PermissionReaderOpts } from "./readers/permission.js";
export {
  qualityStatus,
  type QualityStatusInput,
  type QualityStatusSnapshot,
} from "./readers/quality-status.js";
export { recallStatus, type RecallStatus } from "./readers/recall-status.js";
export {
  readRoutingBiases,
  type ReadRoutingBiasesOpts,
  type RoutingBias,
} from "./readers/routing-bias.js";
export { search } from "./readers/search.js";
export {
  type PressureResult,
  type PressureSnapshot,
  type PressureWarning,
  readSubscriptionPressure,
  type ReadSubscriptionPressureOpts,
} from "./readers/subscription-pressure.js";
export {
  getTaskDraftPromotionInfo,
  type ListPendingEscalationsInput,
  type ListPendingInput,
  type PendingTaskDraft,
  type PendingTaskDraftEscalation,
  TaskDraftReader,
} from "./readers/task-draft.js";
export { timeline } from "./readers/timeline.js";
export { stripPrivacyTags } from "./redaction/privacy-tags.js";
export { DEFAULT_REDACTION_RULES, type RedactionRule, RegexRedactor } from "./redaction/regex.js";
export {
  MAX_WALKER_DEPTH,
  MAX_WALKER_STRING_BYTES,
  type RedactStringResult,
  type RedactValueLimits,
  type RedactValueResult,
  ValuePatternRedactor,
  type ValuePatternRule,
  type ValueRedactionHit,
  WALKER_DEPTH_EXCEEDED_RULE_ID,
  WALKER_STRING_OVERSIZE_RULE_ID,
} from "./redaction/value-patterns.js";
export {
  InvalidEntryTransition,
  InvalidPhaseTransition,
  PhaseNotFound,
  RegistrarNotFound,
  RegistrarSlugTaken,
  UnknownJournalRef,
} from "./registrar/errors.js";
export { RegistrarReader } from "./registrar/reader.js";
export * from "./registrar/schema.js";
export { RegistrarWriter } from "./registrar/writer.js";
export type { WebResearchAdapter, WebResearchResult } from "./research/types.js";
export * from "./routing/index.js";
export * from "./schemas/agent-performance.js";
export * from "./schemas/agent-recommend.js";
export { type ChainStartRequest, ChainStartRequestSchema } from "./schemas/chain.js";
export {
  LONG_LIVED_TICK_STATUS_EVENT_TYPE,
  type T0Event,
  type T0EventInput,
  T0EventInputSchema,
  T0EventSchema,
  TASK_DRAFT_LIFECYCLE_EVENT_TYPES,
  type TaskDraftLifecycleEventType,
} from "./schemas/event.js";
export {
  type ApproveHandoffRequest,
  ApproveHandoffRequestSchema,
  type CreateHandoffRequest,
  CreateHandoffRequestSchema,
  type HandoffRow,
  HandoffRowSchema,
  type HandoffStatus,
  HandoffStatusSchema,
} from "./schemas/handoff.js";
export {
  LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES,
  type LaneCloseMetadata,
  LaneCloseMetadataSchema,
} from "./schemas/lane-close-metadata.js";
export { type T2MemoryRow, T2MemorySchema } from "./schemas/memory.js";
export { hasNonWhitespaceCharacter, nonBlankStringSchema } from "./schemas/non-blank.js";
export {
  type ApprovePermissionRequest,
  ApprovePermissionRequestSchema,
  type CreatePermissionRequest,
  CreatePermissionRequestSchema,
  type PermissionRemember,
  PermissionRememberSchema,
  type PermissionRequestRow,
  PermissionRequestRowSchema,
  type PermissionStatus,
  PermissionStatusSchema,
} from "./schemas/permission.js";
export { assertSafeProjectId, SafeProjectIdSchema } from "./schemas/project-id.js";
export {
  type CorpusBuildRequest,
  CorpusBuildRequestSchema,
  type CorpusFilterInput,
  CorpusFilterSchema,
  type CorpusQueryRequest,
  CorpusQueryRequestSchema,
  type CorpusSummaryRow,
  CorpusSummarySchema,
  type GetObservationsRequest,
  GetObservationsRequestSchema,
  type ObservationDetail,
  type RecallRequest,
  RecallRequestSchema,
  type RecallResult,
  RecallResultSchema,
  type SearchHit,
  type SearchRequest,
  SearchRequestSchema,
  STALE_AFTER_DAYS_DEFAULT as STALE_AFTER_DAYS,
  STALE_AFTER_DAYS_BY_OBS_TYPE,
  STALE_AFTER_DAYS_DEFAULT,
  staleThresholdDays,
  type TimelineEntry,
  type TimelineRequest,
  TimelineRequestSchema,
} from "./schemas/recall.js";
export { type T1RollupRow, T1RollupSchema } from "./schemas/rollup.js";
export * from "./schemas/sse-events.js";
export * from "./schemas/sse.js";
export { type TaskClass, TaskClassSchema } from "./schemas/task-class.js";
export {
  type ParsedTaskDraftLifecyclePayload,
  parseTaskDraftLifecyclePayload,
  type TaskDraftDuplicatePayload,
  TaskDraftDuplicatePayloadSchema,
  type TaskDraftEscalationPayload,
  TaskDraftEscalationPayloadSchema,
  type TaskDraftLifecyclePayload,
  TaskDraftLifecyclePayloadSchema,
  type TaskDraftPayload,
  TaskDraftPayloadSchema,
  type TaskDraftPromotedPayload,
  TaskDraftPromotedPayloadSchema,
  type TaskDraftProvenance,
  TaskDraftProvenanceSchema,
  type TaskDraftRefiningPayload,
  TaskDraftRefiningPayloadSchema,
  type TaskDraftStalePayload,
  TaskDraftStalePayloadSchema,
} from "./schemas/task-draft.js";
export * from "./schemas/write-tools-events.js";
export {
  type AgentRoutingConfig,
  buildServices,
  type BuildServicesOpts,
  type LocalSeatHealthLike,
  type Services,
  type Watchdog,
  type WorkflowRunInfo,
  type WorkflowRunRecord,
  type WorkflowRunsRegistry,
  type WorkflowStatusLight,
} from "./services.js";
export { type ActionGateLike, type McpPoolLike } from "./services.js";
export {
  aggregateHandoffUsage,
  captureAgentPerformanceFromDispatch,
  captureAgentPerformanceFromReconciler,
  meaningfulOutput,
  MIN_RESPONSE_CHARS,
} from "./services/agent-performance-capture.js";
export {
  parseAgentPerformanceMarkdownRows,
  renderAgentPerformanceMarkdown,
} from "./services/agent-performance-markdown.js";
export { recordOperatorAgentPerformance } from "./services/agent-performance-operator.js";
export {
  type AgentRecommendation,
  type DetailMode,
  type DroppedAgentPoolMember,
  isTextOnlyAdapter,
  type ResolvableAgentProviderInput,
  resolveAgentPool,
  type ResolveAgentPoolContext,
  type ResolveAgentPoolResult,
  resolveBiasEffect,
  type ResolvedAgentPoolMember,
  resolveGateOutcomeCutoverIso,
  resolveProvider,
  type RoleRoute,
  routeAgent,
  type RouteAgentInput,
  type RouteAgentOutput,
  type RoutingBiasEffectInput,
} from "./services/agent-routing.js";
export {
  type DispatchEventInput,
  type DispatchEventKind,
  DispatchEventLog,
  type DispatchEventRow,
} from "./services/dispatch-event-log.js";
export {
  refineDispatchPrompt,
  type RefineDispatchPromptOpts,
  RefineError,
  type RefineErrorCode,
  REFINER_INPUT_MAX_BYTES,
  REFINER_OUTPUT_MAX_BYTES,
} from "./services/dispatch-prompt-refiner.js";
export {
  classifyDispatchReliability,
  type DispatchRecommendedAction,
  type DispatchReliabilityEvent,
  type DispatchReliabilityHandoff,
  type DispatchReliabilityInput,
  type DispatchReliabilityReport,
  type DispatchReliabilityStatus,
} from "./services/dispatch-reliability.js";
export {
  collectMentionedPaths,
  type DispatchRoutingGuardInput,
  type DispatchRoutingGuardResult,
  inspectPromptVsProject,
  resolveProjectIdFromAbsolutePath,
} from "./services/dispatch-routing-guard.js";
export {
  createJudgeChat,
  type JudgeChatFn,
  type ResolvedJudgeConfig,
  resolveJudgeConfig,
} from "./services/judge-chat.js";
export {
  collectLlamactlInventory,
  type CollectLlamactlInventoryOpts,
  type LlamactlInventory,
  type LlamactlModelInventory,
  type LlamactlNodeInventory,
} from "./services/llamactl-inventory.js";
export {
  ALLOWED_LLM_PROVIDERS,
  attemptCandidatesInOrder,
  attemptLlmCandidates,
  buildChatCompletionsUrl,
  describeLlmCandidate,
  type LlmAuthSource,
  type LlmCandidate,
  type LlmCandidateAttemptResult,
  type LlmCandidateFailure,
  type LlmProvider,
  type LlmPurpose,
  type LlmRoutingBias,
  type LlmServingCandidate,
  type ResolvedLlmCandidate,
  type ResolveKeychainSecret,
  resolveLlmAuthorization,
  resolveLlmCandidates,
  resolveLlmProvider,
  resolveRoleLlmCandidates,
  type RoleLlmCandidate,
  tryResolveLlmProvider,
} from "./services/llm-candidates.js";
export {
  type Classification,
  classifyFindings,
  type Finding,
} from "./services/memory-efficacy-classifier.js";
export {
  fetchServedModelEntries,
  fetchServedModels,
  type FetchServedModelsOpts,
  type ServedModelEntry,
  type ServedModelsFetch,
  servedModelsUrl,
} from "./services/served-models-client.js";
export {
  extractStumblesFromSession,
  type ExtractStumblesInput,
  type StumbleCandidate,
  type StumbleEvidence,
} from "./services/stumble-extractor.js";
export { type Settings, SettingsDefaults, type SettingsInput, SettingsSchema } from "./settings.js";
export { InProcessSupervisor } from "./supervisor/in-process.js";
export { type AgentRankRow, pickPreferred } from "./tasks/auction.js";
export { TaskCooldowns } from "./tasks/cooldowns.js";
export { type AgentDescriptor, isEligible, TIER_ORDER } from "./tasks/eligibility.js";
export { EmitCapExceeded } from "./tasks/emit-caps.js";
export { type TaskEvent, TaskEventBus } from "./tasks/event-bus.js";
export { ledgerWriteToPerformanceRow, mapTaskEventToLedger } from "./tasks/ledger-bridge.js";
export {
  OrchestrateAgentNotMaestroCapable,
  OrchestrateRecursionForbidden,
  OrchestrateRequiresAllowAgents,
  validateOrchestrateFile,
} from "./tasks/orchestrate-validation.js";
export { pickFromPool } from "./tasks/pick-from-pool.js";
export { TaskReader } from "./tasks/reader.js";
export { mergeDeny, REVIEW_PROMPT_TEMPLATE, synthesizeReviewTask } from "./tasks/review-pairing.js";
export {
  type BoundsInput,
  BoundsInputSchema,
  type CancelTaskInput,
  CancelTaskInputSchema,
  type CompleteTaskInput,
  CompleteTaskInputSchema,
  type Eligibility,
  EligibilitySchema,
  type ExpectedArtifact,
  ExpectedArtifactSchema,
  type FailTaskInput,
  FailTaskInputSchema,
  type FileTaskInput,
  FileTaskInputSchema,
  type GhCreateStatus,
  GhCreateStatusSchema,
  type HeartbeatTaskInput,
  HeartbeatTaskInputSchema,
  type LeaseTaskInput,
  LeaseTaskInputSchema,
  type ReviewVerdict,
  ReviewVerdictSchema,
  type TaskEventKind,
  TaskEventKindSchema,
  type TaskKind,
  TaskKindSchema,
  type TaskPriority,
  TaskPrioritySchema,
  type TaskRecord,
  TaskRecordSchema,
  type TaskStatus,
  TaskStatusSchema,
} from "./tasks/schema.js";
export {
  enqueueGhStatusSyncOnDb,
  InvalidTaskStatus,
  LeaseConflict,
  LeaseInvalid,
  type ListFilters,
  MissingReviewVerdict,
  ReviewParentInvalidState,
  type TaskDescendants,
  type TaskEventRow,
  type TaskInclude,
  type TaskLeaseRow,
  TaskNotFound,
  type TaskWithIncludes,
  TaskWriter,
  UnexpectedReviewVerdict,
} from "./tasks/writer.js";
export { type Clock, systemClock } from "./utils/clock.js";
export { safeParseJSON } from "./utils/json.js";
export { systemUuid, type Uuid } from "./utils/uuid.js";
export type {
  BuildRegistryOpts,
  RegistryEntry,
  RegistryError,
  WorkflowRegistry,
} from "./workflows/registry-interface.js";
export {
  type BranchLandStatus,
  classifyBranchByContent,
  classifyBranchLandStatus,
  isAncestorOf,
  isThreeDotDiffEmpty,
} from "./worktree/branch-land-probe.js";
export { FsPathError, resolveInsideWorktree };

export {
  buildHandoffBranchName,
  type BuildHandoffBranchNameInput,
  deriveBranchNameFromMessage,
  type HandoffBranchNameInput,
  resolveHandoffBranchName,
  slugifyBranchSegment,
} from "./worktree/branch-name.js";
export {
  selectWorktreeGcCandidates,
  type SelectWorktreeGcCandidatesOpts,
  type WorktreeGcCandidate,
  type WorktreeGcCandidateReason,
} from "./worktree/gc-candidates.js";
export {
  ISOLATED_INSTALL_ARGS,
  ISOLATED_INSTALL_CACHE_KEY,
  isPathInsideOrEqual,
  materializeWorkspaceLinks,
  mirrorNodeModuleSymlinks,
  type OrphanWorktreeHandle,
  prepareEscapingFileDependencyLinks,
  provisionLocalCache,
  runIsolatedInstall,
  type WorktreeCommandRunner,
  type WorktreeCommandRunnerOptions,
  type WorktreeHandle,
  WorktreeManager,
  type WorktreeMode,
} from "./worktree/manager.js";
export { AgentPerformanceWriter } from "./writers/agent-performance.js";
export {
  type ApproveOpts,
  type ApproveResult,
  type CreateApprovedParams,
  type CreateHandoffParams,
  HandoffWriter,
} from "./writers/handoff.js";
export {
  type NotificationOutboxEntry,
  type NotificationOutboxKind,
  NotificationOutboxWriter,
} from "./writers/notification-outbox.js";
export {
  type CreatePermissionInput,
  type DecidePermissionInput,
  PermissionWriter,
  type PermissionWriterOpts,
} from "./writers/permission.js";
export { retireMemory, retireNonDirectMemory } from "./writers/retire-memory.js";
export {
  clearRoutingBias,
  type ClearRoutingBiasArgs,
  type ClearRoutingBiasResult,
  setRoutingBias,
  type SetRoutingBiasArgs,
} from "./writers/routing-bias.js";
export {
  extractSessionCandidates,
  type SessionExtractCandidate,
  type SessionExtractOpts,
} from "./writers/session-extract.js";
export { T0Writer } from "./writers/t0.js";
export { T1Rollup, type T1RollupOpts } from "./writers/t1.js";
export { buildT2EmbedText, MAX_BODY_CHARS, validateT2Body } from "./writers/t2-embed-text.js";
export type { T2BodyValidationResult, T2EmbedRecipe } from "./writers/t2-embed-text.js";
export {
  DEFAULT_T2_PROMOTION_MIN_EVENTS,
  type DirectT2WriteInput,
  type DirectT2WriteResult,
  type ExistingNearDuplicateCandidate,
  type LLMJudge,
  readExistingNearDuplicateCandidates,
  type T2MemoryExtraction,
  type T2MemoryWriteInput,
  T2Promotion,
  type T2PromotionOpts,
  verifyMemory,
  writeDirectT2Memory,
  writeT2Memory,
} from "./writers/t2.js";
export { parseWikiLinks } from "./writers/wiki-links.js";
