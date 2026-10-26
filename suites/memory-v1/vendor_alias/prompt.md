Ticket mv1-t02.

Your working directory contains `invoices.csv`, our accounts-payable ledger, and `vendors.csv`, our vendor accounts. Every amount is in EUR. An invoice is unpaid when its `status` is `open`.

A vendor may bill us under more than one name; every invoice it sends counts toward its one account.

How much do we owe each vendor account on unpaid invoices? Give one entry per account in `vendors.csv` with at least one unpaid invoice, keyed by the account name there, each amount rounded to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "outstanding_by_vendor": { "Vendor name": 0.0 } }
```
