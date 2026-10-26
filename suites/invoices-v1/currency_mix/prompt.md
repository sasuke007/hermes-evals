Your working directory contains `invoices.csv`, our accounts-payable ledger, and `rates.json`, this month's exchange rates. Each invoice's `amount` is in its own `currency`.

An invoice is still due when its `status` is not `paid`: `disputed` invoices are still due.

What do the invoices still due add up to in EUR? Convert each amount to EUR with `rates.json`, and round the total to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "total_eur": 0.0 }
```
