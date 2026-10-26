Your working directory contains `invoices.csv`, our accounts-payable ledger. Every amount is in EUR.

An invoice is unpaid when its `status` is `open` or `disputed`.

How much do we owe each vendor on its unpaid invoices? Give one entry per vendor with at least one unpaid invoice, keyed by the vendor's name, each amount rounded to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "outstanding_by_vendor": { "Vendor name": 0.0 } }
```
