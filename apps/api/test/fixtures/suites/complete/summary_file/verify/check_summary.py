"""Checks summary.csv against totals computed from invoices.csv."""
import argparse
import csv
import json
import os
from collections import defaultdict

parser = argparse.ArgumentParser()
parser.add_argument("--answer")
parser.add_argument("--workspace")
parser.add_argument("--home")
args = parser.parse_args()

summary = os.path.join(args.workspace, "summary.csv")
if not os.path.exists(summary):
    print(json.dumps({"score": 0.0, "comment": "summary.csv was not written"}))
    raise SystemExit(0)

want = defaultdict(float)
with open(os.path.join(args.workspace, "invoices.csv")) as f:
    for row in csv.DictReader(f):
        want[row["vendor"]] += float(row["amount"])
with open(summary) as f:
    got = {row["vendor"]: float(row["total"]) for row in csv.DictReader(f)}

right = sum(1 for vendor, total in want.items() if abs(got.get(vendor, -1) - total) < 0.005)
print(json.dumps({"score": right / len(want), "comment": f"{right} of {len(want)} vendors right"}))
