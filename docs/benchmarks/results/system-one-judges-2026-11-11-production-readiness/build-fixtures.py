"""Freeze reviewed fixtures before candidate inference; private historical text stays local."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
PRIVATE = Path("/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/review-200")
SEED = "penumbra-ai-reviewed-source-families-v1"


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def canonical_evidence(items):
    result = []
    for item in items:
        item = item.replace(str(REPO) + "/", "")
        result.append(item)
    return result


historical_key = {row["caseId"]: row for row in rows(PRIVATE / "private-source-key.jsonl")}
source_key = {row["caseId"]: row for row in rows(PRIVATE / "source-private-author-key.jsonl")}
fixtures = []
uncertain = []
for kind, path, key in [("historical", PRIVATE / "historical-ai-merged.jsonl", historical_key), ("synthetic", PRIVATE / "source-ai-merged.jsonl", source_key)]:
    for row in rows(path):
        if row["promote"] is None:
            uncertain.append({"caseId": row["caseId"], "bodySha256": digest(row["body"]), "reason": "truncated-or-ambiguous-visible-input"})
        original = key[row["caseId"]]
        family = "historical:" + digest(original["session_id"]) if kind == "historical" else original["sourceFamily"]
        split = "test" if kind == "historical" else ("calibration" if int(digest(SEED + ":" + family)[:8], 16) / 2**32 < .2 else "test")
        provenance = dict(row["reviewProvenance"])
        provenance["evidence"] = canonical_evidence(provenance["evidence"])
        fixtures.append({
            "id": kind + ":" + row["caseId"], "family": family, "split": split,
            "workload": "promotion", "state": {"kind": "promote_t1", "body": row["body"]},
            "labels": {} if row["promote"] is None else {"promote": row["promote"]}, "labelRationale": row["rationale"],
            "labeler": "+".join(provenance["reviewers"]), "labelStatus": "independently-ai-reviewed",
            "reviewProvenance": provenance,
            "source": {"kind": kind, "sha256": digest(row["body"]), **({"table": "t1_rollups", "id": original["rollup_id"]} if kind == "historical" else {"id": original["authorCaseId"]})},
            "tags": ["independent-ai-reviewed", "common-base-model-reviewers", ("historical-uncertain" if row["promote"] is None else "historical-negative-only") if kind == "historical" else "source-grounded-synthetic"] + (original.get("tags", []) if kind == "synthetic" else []),
        })
fixtures.sort(key=lambda row: digest("frozen-input-order:" + row["id"]))
assert len({row["id"] for row in fixtures}) == len(fixtures)
families = {}
for row in fixtures:
    if row["family"] in families:
        assert families[row["family"]] == row["split"]
    families[row["family"]] = row["split"]


def save(path, data):
    text = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in data)
    if path.exists():
        assert path.read_text() == text, "refuse to overwrite a different frozen fixture"
        return digest(text)
    with path.open("x") as output:
        path.chmod(0o600)
        output.write(text)
    return digest(text)


private_path = PRIVATE / "ai-reviewed-judges-v2.jsonl"
public_path = REPO / "docs/benchmarks/fixtures/system-one-source-reviewed.jsonl"
private_hash = save(private_path, fixtures)
public_hash = save(public_path, [row for row in fixtures if row["source"]["kind"] == "synthetic"])
counts = {}
for row in fixtures:
    key = row["source"]["kind"] + ":" + row["split"] + ":" + str(row["labels"].get("promote"))
    counts[key] = counts.get(key, 0) + 1
manifest = {
    "status": "frozen-before-inference", "splitSeed": SEED,
    "reviewMethod": "Two blind fresh-context AI reviewers with local source checks; six historical disagreements independently AI-adjudicated. Common base model; no human adjudication or independent-training-model claim.",
    "historicalLimit": "No historical positive was adjudicable. Historical negatives are truncated excerpts, with correlated wrapper templates. This is not a prevalence-representative quality estimate.",
    "rows": len(fixtures), "labeledRows": sum(bool(row["labels"]) for row in fixtures), "counts": counts, "uncertainExcludedFromQualityOnly": uncertain,
    "privateFixturePath": str(private_path), "privateRawSha256": private_hash,
    "publicSyntheticFixturePath": str(public_path.relative_to(REPO)), "publicRawSha256": public_hash,
    "provenanceHashes": {name: digest((PRIVATE / name).read_text()) for name in ["reviewer-a.jsonl", "ai-review-a.jsonl", "ai-review-b.jsonl", "ai-adjudicated-disagreements.jsonl", "source-reviewer-a.jsonl", "source-ai-review-a.jsonl", "source-ai-review-b.jsonl", "source-grounded-cases.jsonl"]},
}
(ROOT / "reviewed-fixture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"rows": manifest["rows"], "counts": counts, "uncertain": len(uncertain), "rawSha256": private_hash}))
