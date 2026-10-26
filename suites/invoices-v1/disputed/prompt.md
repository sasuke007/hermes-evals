Your working directory contains `invoices.csv`, our accounts-payable ledger. Every amount is in EUR.

We are preparing this week's payment run. It pays every `open` invoice. `disputed` invoices are held back until their dispute is settled, and `paid` invoices are done.

What is the average amount of an invoice in the payment run, rounded to the cent? Say in a sentence or two which invoices you counted and how.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "average_payable": 0.0 }
```
