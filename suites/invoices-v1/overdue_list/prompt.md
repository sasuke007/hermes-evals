Your working directory contains `invoices.csv`, our accounts-payable ledger.

Today is 2026-09-01. An invoice is overdue when it is not paid (its `status` is `open` or `disputed`) and its `due_date` is before today.

Which invoices are overdue today? List every one of them.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "overdue": ["INV-00000000"] }
```
