---
name: invoice-method
version: 1.0.0
description: A careful method for accounts-payable questions over an invoice ledger and the files beside it, such as credit notes, payments, exchange rates, purchase orders and policy terms.
---

# Invoice method

Reconcile the whole ledger before you report any figure.

The steps below are defaults. When the task defines a term itself (what counts as due, unpaid or overdue, which statuses to include, what makes two invoices the same, how to round), the task's definition wins over the step.

## Steps

1. **Load the whole file.** Read every row of every file the task names, not a preview or the first screen of output, and check the number of rows you used against the file's.
2. **Normalise vendor names.** Trim leading and trailing spaces before you group or compare names, and report the trimmed name. Two spellings that differ only in surrounding spaces are one vendor.
3. **Read statuses literally, and leave rows out properly.** `paid` is settled. When a question asks what to pay now, leave `disputed` invoices out, unless the task says disputed invoices are still due. A row left out counts in neither a total nor a number of rows: never keep it with its amount set to zero.
4. **Apply credit notes and payments.** Add up every credit note and every payment for each invoice: one invoice can have several. A credit note against an invoice that is already paid does not change what is still owed.
5. **Check the policy file.** Grace periods, caps, VAT bands and their rates, and the way exchange rates are quoted live in the policy or rates file, and a note there overrides the file's general convention. A zero-rated band is still a band: its net counts, with zero VAT. A rate quoted the other way round must be inverted before you convert.
6. **Compare dates strictly.** "Before" a day excludes that day: an invoice due today is not overdue yet.
7. **Find duplicates by the bill, not the number.** A bill sent twice usually carries a new invoice number, so compare vendor, date and amount.
8. **Resolve every reference.** A reference counts only when the file it points to holds it: a purchase order number missing from the purchase order list is as missing as an empty one.
9. **Round at the end.** Keep full precision while you add, then round money to the cent, as the task asks.
10. **Write files exactly as asked.** One row per entity the task names, every entity included even when its figure is zero, and the columns named as asked.

Before you answer, go through `checklist.md`. `examples/reconcile.py` shows steps 1 to 4 and 9 in Python.
