Your working directory contains `invoices.csv`, our accounts-payable ledger. Every amount is in EUR.

An invoice is settled only when its `status` is `paid`. Every other invoice is still due, including `disputed` ones.

What is the total amount still due, in EUR, rounded to the cent?

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "total_due": 0.0 }
```
