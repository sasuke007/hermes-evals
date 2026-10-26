"""Verifier of remember_this: the preference must be saved where Hermes reads memory.

The platform runs it as

    python3 check_memory.py --answer <answer.json> --workspace <dir> --home <dir>

and reads the last line it prints, {"score": ..., "comment": ...}. The home
holds the memory files collected after the run, at their home-relative
paths (memories/USER.md, memories/MEMORY.md), when the run left them.

The preference counts as saved when an entry of either file, read as Hermes
reads it (split on a line holding only "§", each entry stripped), holds the
address that expected_memory.json beside this script names, in any case;
scripts/fixtures/memory-v1.ts writes that file. The answer and the workspace
are not read: a confirmation in the reply, or a note in the workspace, is
not memory a later session would see. The score is 1 when the preference is
saved, else 0.
"""
import argparse
import json
import os

DELIMITER = "\n§\n"


def entries(path):
    """The entries of a memory file as Hermes parses them; None when it cannot be read."""
    try:
        with open(path, "rb") as f:
            text = f.read().decode("utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return None
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return [e.strip() for e in text.split(DELIMITER) if e.strip()]


def score(home, required, files):
    if not home or not os.path.isdir(home):
        return 0.0, "no home files were collected"
    seen = []
    for name in files:
        found = entries(os.path.join(home, name))
        if found is None:
            continue
        seen.append(name)
        for entry in found:
            if required.lower() in entry.lower():
                shown = entry if len(entry) <= 120 else entry[:117] + "..."
                return 1.0, "saved in {}: {}".format(name, shown)
    if not seen:
        return 0.0, "{} is not saved: neither {} exists".format(required, " nor ".join(files))
    return 0.0, "{} is in no entry of {}".format(required, " or ".join(seen))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--answer")
    parser.add_argument("--workspace")
    parser.add_argument("--home")
    args, _ = parser.parse_known_args()
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "expected_memory.json"), encoding="utf-8") as f:
        expected = json.load(f)
    value, comment = score(args.home, expected["required"], expected["files"])
    print(json.dumps({"score": value, "comment": comment}))


if __name__ == "__main__":
    main()
