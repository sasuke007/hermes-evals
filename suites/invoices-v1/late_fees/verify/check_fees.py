"""Verifier of late_fees: the fee of every invoice, not only their total.

The platform runs it as

    python3 check_fees.py --answer <answer.json> --workspace <dir> --home <dir>

and reads the last line it prints, {"score": ..., "comment": ...}. The fees
it expects are in expected_fees.json beside it, which
scripts/fixtures/invoices-v1.ts computes from the fixtures; the workspace is
not read, so an agent that edits the ledger cannot change what is expected.

The score is the share of invoices answered right, over every invoice that
is expected or answered: an expected invoice is right when the answer lists
it with a fee within 0.01 of the expected fee, and an answered invoice that
owes no fee counts against the answer. It passes only at 1.
"""
import argparse
import json
import os

TOLERANCE = 0.01 + 1e-9


def as_number(value):
    """A number, or a string that reads as one; None otherwise."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def score(answer, expected):
    if not isinstance(answer, dict) or not isinstance(answer.get("late_fees"), dict):
        return 0.0, "the answer has no late_fees object"
    fees = answer["late_fees"]
    keys = sorted(set(expected) | set(fees))
    wrong = []
    for key in keys:
        if key not in expected:
            wrong.append("{} owes no fee".format(key))
        elif key not in fees:
            wrong.append("{} is missing (fee {:.2f})".format(key, expected[key]))
        else:
            got = as_number(fees[key])
            if got is None or abs(got - expected[key]) > TOLERANCE:
                wrong.append("{}: {} instead of {:.2f}".format(key, json.dumps(fees[key]), expected[key]))
    right = len(keys) - len(wrong)
    comment = "{} of {} invoices right".format(right, len(keys))
    if wrong:
        comment += ": " + "; ".join(wrong[:5]) + ("; ..." if len(wrong) > 5 else "")
    return (right / len(keys) if keys else 1.0), comment


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--answer", required=True)
    parser.add_argument("--workspace")
    parser.add_argument("--home")
    args, _ = parser.parse_known_args()
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "expected_fees.json"), encoding="utf-8") as f:
        expected = json.load(f)["late_fees"]
    with open(args.answer, encoding="utf-8") as f:
        answer = json.load(f)
    value, comment = score(answer, expected)
    print(json.dumps({"score": value, "comment": comment}))


if __name__ == "__main__":
    main()
