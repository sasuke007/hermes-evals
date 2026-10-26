Your working directory contains `invoices.csv`, our accounts-payable ledger, and `policy_terms.json`, our vendors' standard terms. Every amount is in EUR.

Today is 2026-10-15. Vendors charge late fees on `open` invoices we have not paid by their due date, under the late fee terms in `policy_terms.json`. `disputed` invoices are on hold and accrue no fee, and `paid` invoices are settled.

Which open invoices owe a late fee today, and how much do the fees come to? List only invoices whose fee is above zero, each fee rounded to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "late_fees": { "INV-00000000": 0.0 }, "total_late_fees": 0.0 }
```
