#!/usr/bin/env python3
"""bx7.py: read BX-7 bank statement files, as the BX-7 description says.

    python3 bx7.py FILE [FILE ...]             summary of each file
    python3 bx7.py FILE [FILE ...] --by-code   with the movements' totals per reason code
    python3 bx7.py FILE [FILE ...] --records   with every record listed
    python3 bx7.py FILE [FILE ...] --json      the summary as JSON (with --records, every record too)

For each file: the header, the number of records of each type, the opening
balance, money in and money out, the closing balance and the largest
movements, checked against the trailer. Amounts are printed in the
account's currency with two decimals; a negative balance has a minus sign.
Python 3.9 or newer, and nothing else.

Exit status: 0 when every file was read, 1 when a file could not be read
(not BX-7, or a line this reader cannot read), 2 for a usage error.
"""
import argparse
import json
import os
import sys

WIDTH = 64
FORMAT_ID = "BX07"
TYPES = {"A": "header", "B": "opening balance", "E": "movement", "F": "reversal", "Z": "trailer"}


class Unreadable(Exception):
    """A file this reader cannot read; the message says why."""


def money(cents):
    sign = "-" if cents < 0 else ""
    return "%s%d.%02d" % (sign, abs(cents) // 100, abs(cents) % 100)


def as_number(cents):
    return round(cents / 100, 2)


def iso(text, where):
    if len(text) != 8 or not text.isdigit():
        raise Unreadable("%s: the date %r is not YYYYMMDD" % (where, text))
    return "%s-%s-%s" % (text[0:4], text[4:6], text[6:8])


def digits(text, what, where):
    if not text.isdigit():
        raise Unreadable("%s: the %s %r is not a number" % (where, what, text))
    return int(text)


def parse_records(lines):
    """The records of the file, each with its continuation lines folded in."""
    records = []
    for number, line in enumerate(lines, start=1):
        where = "line %d" % number
        if len(line) != WIDTH:
            raise Unreadable("%s is %d characters, not %d" % (where, len(line), WIDTH))
        kind, part = line[0], digits(line[1], "part", where)
        seq = digits(line[2:8], "sequence number", where)
        if kind not in TYPES:
            raise Unreadable("%s: unknown record type %r" % (where, kind))
        if part > 0:
            last = records[-1] if records else None
            if last is None or last["type"] != kind or last["seq"] != seq or last["lines"] != part:
                raise Unreadable("%s: a continuation line that continues nothing" % where)
            last["text"] += line[8:64]
            last["lines"] += 1
            continue
        if seq != len(records) + 1:
            raise Unreadable("%s: record number %06d, expected %06d" % (where, seq, len(records) + 1))
        record = {"type": kind, "seq": seq, "lines": 1, "line": number, "text": ""}
        if kind in "BEF":
            direction = line[16]
            if direction not in "VW":
                raise Unreadable("%s: direction %r is neither V nor W" % (where, direction))
            record.update(date=iso(line[8:16], where), direction=direction,
                          cents=digits(line[17:31], "amount", where))
        if kind in "EF":
            record.update(code=line[31:34], text=line[46:64])
            if kind == "E":
                record["reference"] = line[34:46].strip()
            else:
                record["reverses"] = digits(line[34:40], "reversed record number", where)
        elif kind == "A":
            record.update(format=line[8:12], account=line[12:22], currency=line[22:25],
                          statement_date=iso(line[25:33], where), period_start=iso(line[33:41], where),
                          text=line[41:64])
        elif kind == "Z":
            record.update(count=digits(line[8:14], "trailer count", where),
                          hash_total=digits(line[14:30], "hash total", where))
        records.append(record)
    for record in records:
        record["text"] = record["text"].rstrip()
    return records


def effect(record):
    """What a movement or reversal does to the balance, in cents."""
    adds = record["cents"] if record["direction"] == "V" else -record["cents"]
    return adds if record["type"] == "E" else -adds


def read_statement(path):
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as err:
        raise Unreadable("cannot open it (%s)" % (err.strerror or err))
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError:
        raise Unreadable("it is not plain ASCII text")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines or not lines[0].startswith("A"):
        raise Unreadable("it does not start with a header record")
    if lines[0][8:12] != FORMAT_ID:
        raise Unreadable("format %s is not BX-7; this reader reads %s files only"
                         % (lines[0][8:12].strip() or "(none)", FORMAT_ID))
    records = parse_records(lines)
    kinds = [r["type"] for r in records]
    if len(records) < 3 or kinds[0] != "A" or kinds[1] != "B" or kinds[-1] != "Z" \
            or kinds.count("A") != 1 or kinds.count("B") != 1 or kinds.count("Z") != 1:
        raise Unreadable("it does not run header, opening balance, ..., trailer")
    header, opening, trailer = records[0], records[1], records[-1]
    items = [r for r in records if r["type"] in "EF"]
    reversed_cents = {}
    for item in items:
        if item["type"] != "F":
            continue
        target = records[item["reverses"] - 1] if 0 < item["reverses"] < item["seq"] else None
        if target is None or target["type"] != "E" or target["direction"] != item["direction"]:
            raise Unreadable("line %d: reversal %06d does not name an earlier movement of its direction"
                             % (item["line"], item["seq"]))
        reversed_cents[target["seq"]] = reversed_cents.get(target["seq"], 0) + item["cents"]
        if reversed_cents[target["seq"]] > target["cents"]:
            raise Unreadable("line %d: more is reversed than movement %06d holds"
                             % (item["line"], target["seq"]))
    hash_total = sum(r["cents"] for r in items)
    if trailer["count"] != len(items) or trailer["hash_total"] != hash_total:
        raise Unreadable("the trailer says %d records and %d cents, the file holds %d and %d"
                         % (trailer["count"], trailer["hash_total"], len(items), hash_total))
    return summarise(os.path.basename(path), lines, records, header, opening, items)


def summarise(name, lines, records, header, opening, items):
    def group(kind, direction):
        chosen = [r for r in items if r["type"] == kind and r["direction"] == direction]
        return {"count": len(chosen), "cents": sum(r["cents"] for r in chosen)}

    def largest(direction):
        chosen = [r for r in items if r["type"] == "E" and r["direction"] == direction]
        return max(chosen, key=lambda r: (r["cents"], -r["seq"])) if chosen else None

    by_code = {}
    for item in items:
        entry = by_code.setdefault(item["code"], {
            "movements": {"V": {"count": 0, "cents": 0}, "W": {"count": 0, "cents": 0}},
            "reversals": {"V": {"count": 0, "cents": 0}, "W": {"count": 0, "cents": 0}}})
        cell = entry["movements" if item["type"] == "E" else "reversals"][item["direction"]]
        cell["count"] += 1
        cell["cents"] += item["cents"]
    opening_cents = opening["cents"] if opening["direction"] == "V" else -opening["cents"]
    return {
        "file": name,
        "format": header["format"],
        "account": header["account"],
        "currency": header["currency"],
        "period_start": header["period_start"],
        "statement_date": header["statement_date"],
        "records": {"total": len(records), "header": 1, "opening_balance": 1,
                    "movements": sum(1 for r in items if r["type"] == "E"),
                    "reversals": sum(1 for r in items if r["type"] == "F"), "trailer": 1},
        "lines": {"total": len(lines), "continuation": len(lines) - len(records)},
        "opening_cents": opening_cents,
        "movements": {"V": group("E", "V"), "W": group("E", "W")},
        "reversals": {"V": group("F", "V"), "W": group("F", "W")},
        "money_in_cents": sum(effect(r) for r in items if effect(r) > 0),
        "money_out_cents": -sum(effect(r) for r in items if effect(r) < 0),
        "closing_cents": opening_cents + sum(effect(r) for r in items),
        "largest_in": largest("V"),
        "largest_out": largest("W"),
        "by_code": by_code,
        "items": items,
        "trailer": {"count": len(items), "hash_total": sum(r["cents"] for r in items)},
    }


def describe(record):
    if record is None:
        return "none"
    return "%s on %s (record %06d, %s)" % (money(record["cents"]), record["date"], record["seq"], record["code"])


def print_summary(s, by_code, listing):
    r = s["records"]
    mv, rv = s["movements"], s["reversals"]
    print("file %s: format %s, account %s, currency %s" % (s["file"], s["format"], s["account"], s["currency"]))
    print("period: %s to %s" % (s["period_start"], s["statement_date"]))
    print("records: %d (header 1, opening balance 1, movements %d, reversals %d, trailer 1)"
          % (r["total"], r["movements"], r["reversals"]))
    print("lines: %d, of which %d are continuation lines" % (s["lines"]["total"], s["lines"]["continuation"]))
    print("opening balance: %s" % money(s["opening_cents"]))
    print("money in: %s (movements showing V: %s in %d; reversals showing W: %s in %d)"
          % (money(s["money_in_cents"]), money(mv["V"]["cents"]), mv["V"]["count"],
             money(rv["W"]["cents"]), rv["W"]["count"]))
    print("money out: %s (movements showing W: %s in %d; reversals showing V: %s in %d)"
          % (money(s["money_out_cents"]), money(mv["W"]["cents"]), mv["W"]["count"],
             money(rv["V"]["cents"]), rv["V"]["count"]))
    print("closing balance: %s" % money(s["closing_cents"]))
    print("largest movement in: %s" % describe(s["largest_in"]))
    print("largest movement out: %s" % describe(s["largest_out"]))
    print("trailer: %d movement and reversal records, hash total %d: matches"
          % (s["trailer"]["count"], s["trailer"]["hash_total"]))
    if by_code:
        print("movements by reason code (count and total of those showing V, then W):")
        for code in sorted(s["by_code"]):
            m = s["by_code"][code]["movements"]
            print("  %s  V %d %s  W %d %s" % (code, m["V"]["count"], money(m["V"]["cents"]),
                                             m["W"]["count"], money(m["W"]["cents"])))
    if listing:
        print("records (number, type, date, direction, amount, code, reference or reversed record, text):")
        for item in s["items"]:
            other = item.get("reference") if item["type"] == "E" else "reverses %06d" % item["reverses"]
            print("  %06d %s %s %s %s %s %s %s" % (item["seq"], item["type"], item["date"], item["direction"],
                                                  money(item["cents"]), item["code"], other, item["text"]))


def as_json(s, listing):
    def amounts(group):
        return {d: {"count": g["count"], "total": as_number(g["cents"])} for d, g in group.items()}

    def record(item):
        if item is None:
            return None
        out = {"seq": item["seq"], "type": item["type"], "date": item["date"], "direction": item["direction"],
               "amount": as_number(item["cents"]), "code": item["code"], "text": item["text"]}
        if item["type"] == "E":
            out["reference"] = item["reference"]
        else:
            out["reverses"] = item["reverses"]
        return out

    return {
        "file": s["file"], "format": s["format"], "account": s["account"], "currency": s["currency"],
        "period_start": s["period_start"], "statement_date": s["statement_date"],
        "records": s["records"], "lines": s["lines"],
        "opening_balance": as_number(s["opening_cents"]),
        "money_in": as_number(s["money_in_cents"]), "money_out": as_number(s["money_out_cents"]),
        "closing_balance": as_number(s["closing_cents"]),
        "movements": amounts(s["movements"]), "reversals": amounts(s["reversals"]),
        "largest_in": record(s["largest_in"]), "largest_out": record(s["largest_out"]),
        "by_code": {code: {"movements": amounts(e["movements"]), "reversals": amounts(e["reversals"])}
                    for code, e in sorted(s["by_code"].items())},
        "trailer": s["trailer"],
        "items": [record(item) for item in s["items"]] if listing else None,
    }


def main(argv):
    parser = argparse.ArgumentParser(prog="bx7.py", description="Read BX-7 bank statement files.")
    parser.add_argument("files", nargs="+", metavar="FILE")
    parser.add_argument("--by-code", action="store_true", help="add the movements' totals per reason code")
    parser.add_argument("--records", action="store_true", help="list every record")
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    args = parser.parse_args(argv)
    results, failed = [], False
    if not args.json:
        print("BX-7 reader report")
    for index, path in enumerate(args.files):
        if index > 0 and not args.json:
            print()
        try:
            summary = read_statement(path)
        except Unreadable as err:
            failed = True
            if args.json:
                results.append({"file": os.path.basename(path), "error": str(err)})
            else:
                print("file %s: %s" % (os.path.basename(path), err))
            continue
        if args.json:
            results.append(as_json(summary, args.records))
        else:
            print_summary(summary, args.by_code, args.records)
    if args.json:
        print(json.dumps({"files": results}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
