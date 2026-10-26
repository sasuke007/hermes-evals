Your working directory contains `invoices.csv`, our accounts-payable ledger, and `credit_notes.csv`, the credit notes our vendors have issued against their invoices. Every amount is in EUR.

An invoice is unpaid when its `status` is `open` or `disputed`. A credit note lowers what we owe on the invoice it names.

For every unpaid invoice that has a credit note, what do we still owe after its credit notes? Round each amount to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape, keyed by invoice number:

```json
{ "net_after_credits": { "INV-00000000": 0.0 } }
```
