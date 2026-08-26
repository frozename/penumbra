export interface DiscoveredModel {
  sourceProviderId: string;
  modelId: string;
  displayName: string;
  reasoningTier?: string;
  metadata?: Record<string, unknown>;
}
