import type { ProviderCaps, Services, WindowCaps } from "@penumbra/core";

type ProviderQuotaWithPressureCaps = {
  provider: string;
  model?: string;
  pressure_caps?: WindowCaps;
};

export function buildProviderCaps(
  providerQuotas: Services["providerQuotas"],
): Record<string, ProviderCaps> {
  const out: Record<string, ProviderCaps> = {};
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
