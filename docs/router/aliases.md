# Model task router — alias reconciliation

## What `model-aliases.yaml` is for

`packages/config/src/files/model-aliases.ts` loads
`<config-dir>/model-aliases.yaml` into a `ModelAliasMap`: `Record<seatName,
{ aa_creator, aa_slug, reasoning_level? }>`. It is the only bridge between a
penumbra agent seat name (the string already used everywhere else --
`agents.yaml`'s `name`, a dispatch's `to_agent`, an entry in
`agentRegistry`) and an Artificial Analysis benchmark row.

Without an entry for a seat, that seat gets no AA prior at all:
`computePriors()` skips any agent with no `matchedModels[agent]` entry --
no prior, no `factors` entries for it, and `applyPriorsFactor` in
`agent-routing.ts` leaves its local-history score untouched. In live
dispatches today this is the normal path because the daemon does not pass an
AA snapshot into `decide()` yet; the AA side of alias reconciliation is
currently exercised in core and `replay()` only. This is a silent degrade,
not an error (see "What breaks silently" below).

## Reconciliation procedure

1. Find the seat's real definition in `agents.yaml` (`name`,
   `api_provider`/`subscription_provider`, `adapter`).
2. Find that seat's model on Artificial Analysis (artificialanalysis.ai) or
   in a captured snapshot (`~/.penumbra/aa-snapshot.json`, see
   `operations.md`), and record its exact `model_creator.slug` and `slug`.
3. `aa_creator` must be a canonical provider value: lowercase alphanumerics
   in hyphen-separated segments (`isCanonicalProviderValue`,
   `packages/config/src/provider-format.ts`) -- `openai`, `anthropic`,
   `nvidia-nim`, never `OpenAI` or `open_ai`. `alias-map.ts`'s
   `canonicalizeSnapshotCreator` lowercases the *snapshot* side
   automatically when reconciling, but the alias's `aa_creator` you write in
   the yaml is schema-validated as already canonical -- get it right there.
4. `aa_slug` must match the snapshot row's `slug` exactly.
   `reconcileAliases()` (`alias-map.ts`) keys purely on `(aa_creator,
   aa_slug)` via `aliasLookupKey` -- there is no fuzzy or partial matching.
5. Key the yaml entry by the seat name used everywhere else in penumbra --
   not the AA slug, not a display name.

## Reasoning-level variants are separate AA rows, not a lookup filter

Some model families publish **distinct AA rows per reasoning tier** rather
than one row with a tier field -- e.g. the `gpt-5.6` family's `sol` / `terra`
/ `luna` seat personas each exist as their own AA row (`gpt-5-6-sol`,
`gpt-5-6-terra`, `gpt-5-6-luna`), and `gpt-5-3-codex` is a further, entirely
distinct row -- these are genuinely different slugs, not aliases or tier
variants of one shared row.

Because `reconcileAliases()` matches purely on `(aa_creator, aa_slug)`, the
alias's `reasoning_level` field does **not** select among reasoning-tier
rows. It is metadata: `selectedRoute()` (`router.ts`) copies it onto
`RoutingDecision.selected.reasoningLevel` is copied onto the in-memory
selected route *after* the match already happened via `aa_slug` alone. The
decision log does **not** persist that field today; only the selected agent
and provider are written. If you want a seat's AA-derived priors to reflect
its actually-configured reasoning tier, `aa_slug` must already point at the
AA row for that exact tier -- consult the live snapshot for the tier-specific
slug rather than assuming a naming pattern (e.g. a `-high` suffix), since
AA's slug naming is not guaranteed consistent across model families. Set
`reasoning_level` afterward for in-memory selection only.

## Hand-maintained CODEX_CONFIG-embedded seats

The Codex ACP seats (`openai-codex-sol-acp`, `openai-codex-terra-acp`,
`openai-codex-luna-acp`, and similar) run the same adapter binary pointed
at a different underlying model per seat via adapter-level configuration,
rather than one static model field. That embedded configuration lives
outside this repo's tracked docs tree, so it can't be introspected here --
treat the **seat name** as the reconciliation anchor regardless, and
reconcile these exactly like any other seat (steps 1-5 above):

```yaml
openai-codex-sol-acp:
  aa_creator: openai
  aa_slug: gpt-5-6-sol
openai-codex-terra-acp:
  aa_creator: openai
  aa_slug: gpt-5-6-terra
openai-codex-luna-acp:
  aa_creator: openai
  aa_slug: gpt-5-6-luna
openai-codex-classic-acp:
  aa_creator: openai
  aa_slug: gpt-5-3-codex
```

Because the embedded model config for these seats can change without a
`model-aliases.yaml` change (nothing here reads the adapter config to
detect drift), re-verify this mapping whenever a Codex seat's underlying
model changes. See `operations.md`'s "Known limitations" -- there is no
automated alert for a stale alias today.

## What breaks silently if you get this wrong

- **Wrong `aa_slug`** (typo, or stale after an AA rename): `{ unmatched:
  "alias_matches_no_snapshot_model" }`. No error is raised anywhere -- the
  seat simply never gets a prior, indefinitely, until someone notices the
  gap in its `factors` array.
- **Two seats' `(aa_creator, aa_slug)` collide because the snapshot itself
  has a duplicate or ambiguous row**: `{ unmatched:
  "alias_matches_multiple_snapshot_models" }` for every seat with that
  pair. This is a deliberate ambiguity guard, not a bug to work around --
  legitimately having *multiple seats point at one model* is fine and
  common (`model-aliases.ts`'s own comment: "Multiple seats legitimately
  run the same underlying model"); this reason only fires when the
  *snapshot* is ambiguous, i.e. more than one AA row shares the same
  `(creator, slug)` pair.
- **No entry at all**: `{ unmatched: "no_alias_configured" }` -- same
  silent local-history-only fallback as a wrong slug.

The unmatched-alias reason is **not** surfaced in `RoutingDecision`'s
`factors` or `alternatives` arrays today; it is resolved before those fields
are assembled. None of these three states is surfaced outside an individual
decision's payload -- there is no aggregate "N seats have no usable alias"
signal today (`operations.md`).
