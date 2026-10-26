Ticket mv1-t08.

Your working directory contains `invoices.csv`, our accounts-payable ledger. Every amount is in EUR.

Today is 2026-10-20. An invoice is overdue when its `status` is `open` and its `due_date` is before today.

Draft an email from me to the accounts team at Fennick Electrical about its overdue invoices. List each one with its invoice number, due date and amount, give their total, and ask them to confirm the balance. Keep the tone friendly and personal.

End your reply with the email as a fenced JSON block, exactly in this shape:

```json
{ "subject": "...", "body": "..." }
```
