"""Verifier of summary_file: the values in summary.csv, row by row.

The platform runs it as

    python3 check_summary.py --answer <answer.json> --workspace <dir> --home <dir>

and reads the last line it prints, {"score": ..., "comment": ...}. The rows
it expects are in expected_summary.json beside it, which
scripts/fixtures/invoices-v1.ts computes from the fixtures; only summary.csv
is read from the workspace, so an agent that edits the ledger cannot change
what is expected.

A vendor's row is right when its name (surrounding spaces ignored) matches,
unpaid_invoices is the expected count and outstanding is within 0.01 of the
expected amount. The score is the share of right rows over the expected
vendors or the rows written, whichever is more, so a missing vendor, a vendor
written twice or a row for no vendor all lower it. It passes only at 1. No
summary.csv, or one without the three columns, scores 0: the agent's
failure, not the check's.
"""
import argparse
import csv
import json
import os

TOLERANCE = 0.01 + 1e-9
COLUMNS = ("vendor", "unpaid_invoices", "outstanding")


def read_rows(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        header = [name.strip() for name in (reader.fieldnames or [])]
        missing = [c for c in COLUMNS if c not in header]
        if missing:
            return None, "summary.csv has no column {}".format(", ".join(missing))
        reader.fieldnames = header
        return list(reader), None


def matches(row, want):
    try:
        count = int((row.get("unpaid_invoices") or "").strip())
        amount = float((row.get("outstanding") or "").strip())
    except ValueError:
        return False
    return count == want["unpaid_invoices"] and abs(amount - want["outstanding"]) <= TOLERANCE


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--answer")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--home")
    args, _ = parser.parse_known_args()
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "expected_summary.json"), encoding="utf-8") as f:
        expected = {row["vendor"]: row for row in json.load(f)["rows"]}

    path = os.path.join(args.workspace, "summary.csv")
    if not os.path.isfile(path):
        print(json.dumps({"score": 0, "comment": "summary.csv not found in the workspace"}))
        return
    rows, problem = read_rows(path)
    if problem:
        print(json.dumps({"score": 0, "comment": problem}))
        return

    seen = {}
    for row in rows:
        name = (row.get("vendor") or "").strip()
        seen.setdefault(name, []).append(row)
    wrong = []
    for name, want in expected.items():
        found = seen.get(name, [])
        if not found:
            wrong.append("no row for {}".format(name))
        elif len(found) > 1:
            wrong.append("{} rows for {}".format(len(found), name))
        elif not matches(found[0], want):
            wrong.append("{}: {} unpaid, {} outstanding instead of {}, {:.2f}".format(
                name, found[0].get("unpaid_invoices"), found[0].get("outstanding"),
                want["unpaid_invoices"], want["outstanding"]))
    extra = [name for name in seen if name not in expected]
    wrong += ["a row for {}, which is not a vendor".format(json.dumps(name)) for name in extra]
    right = len(expected) - len([w for w in wrong if not w.startswith("a row for")])
    total = max(len(expected), len(rows))
    comment = "{} of {} vendor rows right".format(right, len(expected))
    if wrong:
        comment += ": " + "; ".join(wrong[:5]) + ("; ..." if len(wrong) > 5 else "")
    print(json.dumps({"score": right / total, "comment": comment}))


if __name__ == "__main__":
    main()
