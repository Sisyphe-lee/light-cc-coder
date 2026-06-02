#!/usr/bin/env python3
"""Load public SWE-bench instances and emit only safe fields.

This helper intentionally strips gold patches, hidden tests, FAIL_TO_PASS, and
PASS_TO_PASS before TypeScript code writes any per-instance artifacts.
"""

from __future__ import annotations

import argparse
import json
import sys

SAFE_FIELDS = ("instance_id", "repo", "base_commit", "problem_statement")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-name", required=True)
    parser.add_argument("--split", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--instance", action="append", default=[])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        from datasets import load_dataset
    except Exception as exc:
        print(
            "Missing Python dependency 'datasets'. Install swebench==4.1.0 or datasets before loading SWE-bench instances.",
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        return 2

    dataset = load_dataset(args.dataset_name, split=args.split, revision=args.revision)
    selected = []
    wanted = set(args.instance)
    for row in dataset:
        if wanted and row.get("instance_id") not in wanted:
            continue
        selected.append({field: row[field] for field in SAFE_FIELDS})
        if args.limit and len(selected) >= args.limit:
            break

    if wanted:
        found = {item["instance_id"] for item in selected}
        missing = sorted(wanted - found)
        if missing:
            print(f"Missing requested instances: {', '.join(missing)}", file=sys.stderr)
            return 2

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(selected, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
