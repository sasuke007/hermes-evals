"""Checks MEMORY.md in the collected home: the seed entry kept, the preference added."""
import argparse
import json
import os

parser = argparse.ArgumentParser()
parser.add_argument("--answer")
parser.add_argument("--workspace")
parser.add_argument("--home", required=True)
args = parser.parse_args()

path = os.path.join(args.home, "memories", "MEMORY.md")
if not os.path.exists(path):
    print(json.dumps({"score": 0.0, "comment": "memories/MEMORY.md is not in the home"}))
    raise SystemExit(0)

with open(path, encoding="utf-8") as f:
    # Hermes's entry delimiter (tools/memory_tool_store.py ENTRY_DELIMITER).
    entries = [e.strip() for e in f.read().split("\n§\n") if e.strip()]
kept = any("trailing spaces" in e for e in entries)
added = any("largest first" in e for e in entries)
print(json.dumps({"score": (kept + added) / 2, "comment": f"seed kept: {kept}, preference saved: {added}"}))
