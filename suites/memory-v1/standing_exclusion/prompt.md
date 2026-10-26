Ticket mv1-t03.

Your working directory contains `invoices.csv`, our accounts-payable ledger. Every amount is in EUR. An invoice is unpaid when its `status` is `open`.

I am putting together my payables report. Give me its vendor table: what we owe each vendor on unpaid invoices, one entry per vendor with at least one unpaid invoice, keyed by the vendor's name, each amount rounded to the cent, following my usual conventions for this report.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "payables": { "Vendor name": 0.0 } }
```
