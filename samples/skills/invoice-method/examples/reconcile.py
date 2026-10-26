"""A worked reconciliation: what is still owed per invoice and per vendor.

    python3 reconcile.py <ledger.csv> [--credit-notes <file>] [--payments <file>]
                         [--include-disputed]

Reads the ledger in full, trims vendor names, applies every credit note and
every payment of each invoice, leaves paid invoices out, and leaves disputed
ones out too unless --include-disputed says they are still due. Rows left
out are skipped, never kept at zero. Amounts are Decimals, rounded to the
cent only when printed.

Column names are the common ones (invoice_no, vendor_name, amount, status;
invoice_no and amount in the credit note and payment files); adapt them, and
every rule above, to what the task defines.
"""
import argparse
import csv
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")


def read_all(path):
    """Every row of a CSV file, with the count, so nothing is answered from a preview."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    print("{}: {} rows".format(path, len(rows)))
    return rows


def totals_by_invoice(path):
    """The sum per invoice of a file of credit notes or payments: one invoice can have several."""
    totals = defaultdict(Decimal)
    if path:
        for row in read_all(path):
            totals[row["invoice_no"].strip()] += Decimal(row["amount"])
    return totals


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("ledger")
    parser.add_argument("--credit-notes", dest="credits")
    parser.add_argument("--payments")
    parser.add_argument("--include-disputed", action="store_true")
    args = parser.parse_args()

    credits = totals_by_invoice(args.credits)
    payments = totals_by_invoice(args.payments)
    statuses = {"open", "disputed"} if args.include_disputed else {"open"}

    owed = {}
    by_vendor = defaultdict(Decimal)
    for row in read_all(args.ledger):
        if row["status"].strip() not in statuses:
            continue  # left out: in no total and no count
        number = row["invoice_no"].strip()
        vendor = row["vendor_name"].strip()
        balance = Decimal(row["amount"]) - credits[number] - payments[number]
        owed[number] = (vendor, balance)
        by_vendor[vendor] += balance

    for number, (vendor, balance) in sorted(owed.items()):
        print("{}  {:<24} {:>12}".format(number, vendor, balance.quantize(CENT, ROUND_HALF_UP)))
    for vendor, balance in sorted(by_vendor.items()):
        print("{:<24} {:>12}".format(vendor, balance.quantize(CENT, ROUND_HALF_UP)))
    print("invoices counted: {}".format(len(owed)))


if __name__ == "__main__":
    main()
