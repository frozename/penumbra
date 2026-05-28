import type { Services } from "@penumbra/core";

type WindowCaps = Record<string, { warn: number | null; refuse: number }>;
export type ProviderCapsShape = { default: WindowCaps; perModel?: Record<string, WindowCaps> };

type ProviderQuotaWithPressureCaps = {
  provider: string;
  model?: string;
  pressure_caps?: Record<string, { warn: number | null; refuse: number }>;
};

export function buildProviderCaps(
  providerQuotas: Services["providerQuotas"],
): Record<string, ProviderCapsShape> {
  const out: Record<string, ProviderCapsShape> = {};
  for (const quota of providerQuotas as ProviderQuotaWithPressureCaps[]) {
    if (!quota.pressure_caps) continue;
    const entry = (out[quota.provider] ??= { default: {}, perModel: undefined });
    if (quota.model) {
      entry.perModel ??= {};
      entry.perModel[quota.model] = {
        ...(entry.perModel[quota.model] ?? {}),
        ...quota.pressure_caps,
      };
    } else {
      entry.default = { ...entry.default, ...quota.pressure_caps };
    }
  }
  return out;
}
