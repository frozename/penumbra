import { isCanonicalProviderValue, type ModelAliasMap } from "@penumbra/config";

import type { AaModel, AaModelSnapshot } from "./schemas.js";

export type AliasIndexEntry = {
  aaCreator: string;
  aaSlug: string;
  lookupKey: string;
};

export type AliasIndex = ReadonlyMap<string, AliasIndexEntry>;

export type AliasUnmatchedReason =
  | "no_alias_configured"
  | "alias_matches_no_snapshot_model"
  | "alias_matches_multiple_snapshot_models";

export type AliasReconciliationResult = { matched: AaModel } | { unmatched: AliasUnmatchedReason };

export function buildAliasIndex(aliases: ModelAliasMap): AliasIndex {
  const index = new Map<string, AliasIndexEntry>();

  for (const [seatName, alias] of Object.entries(aliases)) {
    index.set(seatName, {
      aaCreator: alias.aa_creator,
      aaSlug: alias.aa_slug,
      lookupKey: aliasLookupKey(alias.aa_creator, alias.aa_slug),
    });
  }

  return index;
}

export function reconcileAliases(
  index: AliasIndex,
  snapshot: AaModelSnapshot,
  seatNames: readonly string[],
): Record<string, AliasReconciliationResult> {
  const snapshotIndex = buildSnapshotIndex(snapshot);
  const result: Record<string, AliasReconciliationResult> = {};

  for (const seatName of seatNames) {
    const alias = index.get(seatName);

    if (!alias) {
      result[seatName] = { unmatched: "no_alias_configured" };
      continue;
    }

    const matches = snapshotIndex.get(alias.lookupKey) ?? [];
    if (matches.length === 0) {
      result[seatName] = { unmatched: "alias_matches_no_snapshot_model" };
      continue;
    }

    if (matches.length > 1) {
      result[seatName] = { unmatched: "alias_matches_multiple_snapshot_models" };
      continue;
    }

    const matched = matches[0];
    if (matched === undefined) continue;
    result[seatName] = { matched };
  }

  return result;
}

function buildSnapshotIndex(snapshot: AaModelSnapshot): Map<string, AaModel[]> {
  const index = new Map<string, AaModel[]>();

  for (const model of snapshot.models) {
    const key = aliasLookupKey(canonicalizeSnapshotCreator(model.model_creator.slug), model.slug);
    const existing = index.get(key);

    if (existing) {
      existing.push(model);
    } else {
      index.set(key, [model]);
    }
  }

  return index;
}

function canonicalizeSnapshotCreator(value: string): string {
  if (isCanonicalProviderValue(value)) return value;

  const lower = value.toLowerCase();
  return isCanonicalProviderValue(lower) ? lower : value;
}

function aliasLookupKey(aaCreator: string, aaSlug: string): string {
  return `${aaCreator}\u0000${aaSlug}`;
}
