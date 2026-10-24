"""Scores the answer's count against the rows of rows.csv."""
import argparse
import csv
import json
import os

parser = argparse.ArgumentParser()
parser.add_argument("--answer")
parser.add_argument("--workspace")
args = parser.parse_args()

with open(args.answer) as f:
    answer = json.load(f)
with open(os.path.join(args.workspace, "rows.csv")) as f:
    rows = len(list(csv.DictReader(f)))
ok = isinstance(answer, dict) and answer.get("count") == rows
print(json.dumps({"score": 1.0 if ok else 0.0, "comment": f"rows.csv has {rows} rows"}))
