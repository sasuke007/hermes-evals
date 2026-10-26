Your working directory contains `invoices.csv`, our accounts-payable ledger. Every amount is in EUR.

An invoice is unpaid when its `status` is `open` or `disputed`.

Write `summary.csv` in the working directory, with one row per vendor in `invoices.csv`, sorted by vendor name, and exactly these columns:

- `vendor`: the vendor's name;
- `unpaid_invoices`: how many of its invoices are unpaid;
- `outstanding`: the total amount of those invoices, with two decimals, for example `1234.50`.

End your reply with a fenced JSON block naming the file and its number of data rows, exactly in this shape:

```json
{ "summary_file": "summary.csv", "rows": 0 }
```
