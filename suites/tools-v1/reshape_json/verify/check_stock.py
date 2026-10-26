"""Verifier of reshape_json: the quantities in stock_by_sku.json, SKU by SKU.

The platform runs it as

    python3 check_stock.py --answer <answer.json> --workspace <dir> --home <dir>

and reads the last line it prints, {"score": ..., "comment": ...}. The
entries it expects are in expected_stock.json beside it, which
scripts/fixtures/tools-v1.ts computes from inventory.json; only
stock_by_sku.json is read from the workspace, so an agent that edits the
export cannot change what is expected.

A SKU's entry is right when its `total` is the expected integer and its
`warehouses` object holds exactly the expected warehouses with the expected
integer quantities (a number such as 12.0 counts as 12; a string or a
boolean never does). The score is the share of right entries over the
expected SKUs or the entries written, whichever is more, so a missing SKU,
a wrong quantity or an entry for no SKU all lower it. It passes only at 1.
No stock_by_sku.json, or one that is not a JSON object, scores 0: the
agent's failure, not the check's.
"""
import argparse
import json
import os

FILE = "stock_by_sku.json"


def quantity(value):
    """The value as an int when it is a whole number, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value) if value == int(value) else None


def matches(entry, want):
    if not isinstance(entry, dict) or set(entry) != {"total", "warehouses"}:
        return False
    held = entry["warehouses"]
    if not isinstance(held, dict) or set(held) != set(want["warehouses"]):
        return False
    if quantity(entry["total"]) != want["total"]:
        return False
    return all(quantity(held[w]) == q for w, q in want["warehouses"].items())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--answer")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--home")
    args, _ = parser.parse_known_args()
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "expected_stock.json"), encoding="utf-8") as f:
        expected = json.load(f)

    path = os.path.join(args.workspace, FILE)
    if not os.path.isfile(path):
        print(json.dumps({"score": 0, "comment": "{} not found in the workspace".format(FILE)}))
        return
    try:
        with open(path, encoding="utf-8-sig") as f:
            written = json.load(f)
    except ValueError as err:
        print(json.dumps({"score": 0, "comment": "{} is not valid JSON: {}".format(FILE, err)}))
        return
    if not isinstance(written, dict):
        print(json.dumps({"score": 0, "comment": "{} is not a JSON object".format(FILE)}))
        return

    wrong = []
    for sku, want in sorted(expected.items()):
        if sku not in written:
            wrong.append("no entry for {}".format(sku))
        elif not matches(written[sku], want):
            wrong.append("{}: {} instead of {}".format(
                sku, json.dumps(written[sku], sort_keys=True), json.dumps(want, sort_keys=True)))
    extra = sorted(sku for sku in written if sku not in expected)
    right = len(expected) - len(wrong)
    wrong += ["an entry for {}, which is not a SKU of the export".format(json.dumps(sku)) for sku in extra]
    total = max(len(expected), len(written))
    comment = "{} of {} SKU entries right".format(right, len(expected))
    if wrong:
        comment += ": " + "; ".join(wrong[:5]) + ("; ..." if len(wrong) > 5 else "")
    print(json.dumps({"score": right / total, "comment": comment}))


if __name__ == "__main__":
    main()
