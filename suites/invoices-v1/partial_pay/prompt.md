Your working directory contains `invoices.csv`, our accounts-payable ledger, and `payments.csv`, the part payments we have made against `open` invoices. Every amount is in EUR.

For each open invoice with at least one payment, what balance is left to pay after its payments? Round each balance to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape, keyed by invoice number:

```json
{ "balances": { "INV-00000000": 0.0 } }
```
