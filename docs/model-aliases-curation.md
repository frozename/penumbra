# model-aliases.yaml curation notes

> **Why this file exists:** `~/.config/penumbra/model-aliases.yaml` is rewritten wholesale by
> `penumbra config sync-providers --apply` (managed-alias upserts re-serialize the whole map),
> so **comments in that file do not survive**. The curation rationale below originally lived as
> comments in the hand-authored file and was destroyed by the first apply on 2026-08-26; this
> tracked doc is its durable home. Check drift with `penumbra config check-aliases` — the
> Matched/Dark/Missing report is the self-auditing view; this doc only records the *reasons*.

## Snapshot basis

Matched against `~/.penumbra/aa-snapshot.json` (618 models). Every `aa_creator`/`aa_slug` pair
in the alias map must exist verbatim (and uniquely) in that snapshot; entries that stop matching
show up as **Dark** in `check-aliases` — treat a new Dark entry as snapshot/catalog drift, not
noise.

## Deliberately DARK or MISSING (no alias entry, with reasons)

| Seat | Reason |
| --- | --- |
| `sakana-fugu-ultra-http`, `sakana-fugu-http`, `codex-sakana-acp`, `codex-sakana-fugu-acp` | no sakana models in the AA snapshot |
| `openai-codex-acp`, `openai-codex-spark-acp` | `gpt-5-3-codex-spark` absent from AA |
| `openai-codex-fast-acp` | `gpt-5-4-mini-low` absent from AA |
| `devin-swe-1-7-acp`, `devin-glm-5-2-acp` | replaced the deleted `devin-acp`. `devin-swe-1-7-acp` currently has no alias configured — no AA priors, routes on local history alone. `devin-glm-5-2-acp` IS alias-mapped (`aa_creator zai` / `aa_slug glm-5-2`), sharing the mapping with the pre-existing `opencode-glm-52-acp` seat |
| `local-bge-m3-http` | embedder; AA carries no embedding models |
| `local-qwen36-35b-a3b-mlx-http` | declares granite-mini-3b; seat quirk: DEAD, not serving its named model |

Generator-created aliases that are Dark because their model is AA-absent (e.g.
`sakana-fugu-ultra-v1-*-http`, `deepseek-deepseek-v4-flash-vision-exp-http`) are honest
reporting, not curation debt — they clear on their own if AA picks the models up.

## Maintenance rules

- Hand entries in `model-aliases.yaml` survive `--apply` (only generator-owned aliases are
  upserted), but comments never do — record rationale **here**, not there.
- Seat renames must move the alias key in lockstep (done 2026-08-26 for
  `planner` → `local-lfm2-planner-http`, `executor` → `local-lfm2-executor-http`).
- Backups of the pre-apply hand-authored file: `model-aliases.yaml.bak-pre-first-apply-20260826`
  in `~/.config/penumbra/`.
