Request tv1-big_csv.

Your working directory contains `transactions.csv`, a card-payments export with one transaction per row after the header: 20,000 rows, with the columns `id`, `account`, `amount` (in EUR, two decimals) and `status` (`settled`, `pending` or `reversed`).

What is the total `amount` of the transactions whose `status` is `settled`, over every row of the file, in EUR, rounded to the cent?

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "settled_total": 0.0 }
```
