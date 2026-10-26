Ticket mv1-t06.

Your working directory contains `invoices.csv`, our accounts-payable ledger. Every amount is in EUR. An invoice is unpaid when its `status` is `open`.

I need to book Gorsebank Freight's unpaid invoices to their cost centre. Which cost centre does each of them go to?

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "cost_centres": { "INV-00000": "CC-0000" } }
```
