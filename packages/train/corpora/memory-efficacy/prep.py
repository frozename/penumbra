#!/usr/bin/env python3
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, MutableMapping


ROOT = Path(__file__).resolve().parents[3]
PRIMARY_CORPUS_PATH = ROOT / "tools" / "memory-efficacy-bench" / "corpus"
FALLBACK_CORPUS_PATH = Path("/Volumes/WorkSSD/repos/personal/llamactl/tools/memory-efficacy-bench/corpus")

CLASS_PROMPT = (
    "Classify the following finding into one of: missed_registration, recall_miss, memory_ignored, not_memory_related.\n\n"
    "missed_registration: would have been prevented by a memory that was never written.\n"
    "recall_miss: a relevant memory existed but autoRecallForDispatch returned 0 hits.\n"
    "memory_ignored: a relevant memory was recalled but disregarded.\n"
    "not_memory_related: not about memory efficacy.\n\n"
    "Return JSON only: {\"classification\": \"...\", \"reason\": \"...\"}\n\n"
)
BINARY_PROMPT = (
    "Is the following finding about memory efficacy (a missed registration, recall miss, or ignored memory)?\n\n"
    "Return JSON only: {\"memory_related\": true|false, \"reason\": \"...\"}\n\n"
)

CLASS_ORDER = ["missed_registration", "recall_miss", "memory_ignored", "not_memory_related"]
BINARY_ORDER = ["memory_related", "not_memory_related"]


def _resolve_corpus_dir() -> Path:
    for path in (PRIMARY_CORPUS_PATH, FALLBACK_CORPUS_PATH):
        if path.is_dir():
            findings = path / "findings.json"
            labels = path / "gold-labels.json"
            if findings.is_file() and labels.is_file():
                return path
    raise FileNotFoundError(
        f"Missing corpus inputs in expected locations: {PRIMARY_CORPUS_PATH}, {FALLBACK_CORPUS_PATH}"
    )


def _load_json(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise TypeError(f"Expected an array in {path}")
    return data


def _append_finding_prefix(severity: Any, text: str) -> str:
    if severity is None:
        return f"Finding: {text}"
    return f"Finding: [{severity}] {text}"


def _build_record(
    prompt_prefix: str,
    payload: dict[str, Any],
    is_binary: bool,
    severity: Any,
    text: str,
    classification: str,
) -> dict[str, str]:
    prompt = prompt_prefix + _append_finding_prefix(severity, text)
    if is_binary:
        completion_obj = {
            "memory_related": classification != "not_memory_related",
            "reason": payload.get("reason", ""),
        }
    else:
        completion_obj = {
            "classification": classification,
            "reason": payload.get("reason", ""),
        }
    completion = " " + json.dumps(completion_obj, ensure_ascii=False, separators=(",", ":"))
    return {"prompt": prompt, "completion": completion}


def _split_index(i: int) -> str:
    mod = i % 10
    if mod <= 7:
        return "train"
    if mod == 8:
        return "valid"
    return "test"


def _build_splits(
    rows_by_class: dict[str, list[dict[str, Any]]],
    class_order: list[str],
    prompt_prefix: str,
    map_class: bool,
) -> tuple[dict[str, list[dict[str, str]]], dict[str, dict[str, int]]]:
    splits: dict[str, list[dict[str, str]]] = {"train": [], "valid": [], "test": []}
    counts: dict[str, dict[str, int]] = {
        "train": {c: 0 for c in class_order},
        "valid": {c: 0 for c in class_order},
        "test": {c: 0 for c in class_order},
    }

    for source_class in class_order:
        rows = sorted(rows_by_class.get(source_class, []), key=lambda r: r["findingId"])
        for idx, row in enumerate(rows):
            split_name = _split_index(idx)
            target_class = source_class
            if map_class:
                target_class = "memory_related" if source_class != "not_memory_related" else "not_memory_related"

            record = _build_record(
                prompt_prefix=prompt_prefix,
                payload=row,
                is_binary=map_class,
                severity=row.get("severity"),
                text=row.get("text", ""),
                classification=target_class,
            )
            splits[split_name].append(record)
            counts[split_name][target_class] += 1

    return splits, counts


def _write_jsonl(path: Path, rows: Iterable[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")


def _format_table(counts: dict[str, dict[str, int]], class_order: list[str], title: str) -> str:
    out = [title]
    for split in ("train", "valid", "test"):
        bits = [f"{cls}={counts[split][cls]}" for cls in class_order]
        out.append(f"{split}: " + ", ".join(bits))
    return "\n".join(out)


def main() -> None:
    corpus_dir = _resolve_corpus_dir()
    print(f"Using corpus inputs from: {corpus_dir}")

    findings = _load_json(corpus_dir / "findings.json")
    labels = _load_json(corpus_dir / "gold-labels.json")

    labels_by_id = {item["findingId"]: item for item in labels if "findingId" in item}

    rows_by_class: dict[str, list[dict[str, Any]]] = {
        "missed_registration": [],
        "recall_miss": [],
        "memory_ignored": [],
        "not_memory_related": [],
    }

    skipped_count = 0
    for finding in findings:
        finding_id = finding.get("findingId")
        if finding_id is None:
            skipped_count += 1
            continue
        label = labels_by_id.get(finding_id)
        if label is None:
            skipped_count += 1
            print(f"Skipping finding without label: {finding_id}")
            continue
        cls = label.get("classification", "")
        if cls not in rows_by_class:
            continue
        rows_by_class[cls].append({
            "findingId": finding_id,
            "classification": cls,
            "reason": label.get("reason", ""),
            "severity": finding.get("severity"),
            "text": finding.get("text", ""),
        })

    if skipped_count:
        print(f"Skipped {skipped_count} findings without labels")

    fourway_splits, fourway_counts = _build_splits(
        rows_by_class=rows_by_class,
        class_order=CLASS_ORDER,
        prompt_prefix=CLASS_PROMPT,
        map_class=False,
    )
    binary_rows_by_class = {
        "memory_related": [
            row for row in rows_by_class["missed_registration"]
        ] + [
            row for row in rows_by_class["recall_miss"]
        ] + [
            row for row in rows_by_class["memory_ignored"]
        ],
        "not_memory_related": rows_by_class["not_memory_related"],
    }
    binary_splits, binary_counts = _build_splits(
        rows_by_class=binary_rows_by_class,
        class_order=BINARY_ORDER,
        prompt_prefix=BINARY_PROMPT,
        map_class=True,
    )

    output_root = Path(__file__).resolve().parent
    for split_name, rows in fourway_splits.items():
        _write_jsonl(output_root / "4way" / f"{split_name}.jsonl", rows)

    for split_name, rows in binary_splits.items():
        _write_jsonl(output_root / "binary" / f"{split_name}.jsonl", rows)

    print(_format_table(fourway_counts, CLASS_ORDER, "4-way split table:"))
    print(_format_table(binary_counts, BINARY_ORDER, "Binary split table:"))


if __name__ == "__main__":
    main()
