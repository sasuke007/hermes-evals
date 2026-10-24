"""Reads the wrong key, so the reference answer scores 0.2 and the self-check fails."""
import argparse
import json

parser = argparse.ArgumentParser()
parser.add_argument("--answer")
parser.add_argument("--workspace")
args = parser.parse_args()
with open(args.answer) as f:
    answer = json.load(f)
print(json.dumps({"score": 0.2, "comment": f"no 'total' in {sorted(answer)}"}))
