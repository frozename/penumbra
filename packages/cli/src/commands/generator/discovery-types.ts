export interface DiscoveredModel {
  sourceProviderId: string;
  modelId: string;
  displayName: string;
  reasoningTier?: string;
  metadata?: Record<string, unknown>;
}

export interface DiscoveryDiagnostic {
  row: string;
  reason: string;
}

export interface DiscoveryReport {
  outcome: "discovered";
  models: DiscoveredModel[];
  diagnostics?: DiscoveryDiagnostic[];
}
