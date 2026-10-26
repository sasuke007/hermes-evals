Your working directory contains `invoices.csv`, our accounts-payable ledger.

Vendors sometimes send the same bill twice, each time under a new invoice number, and we must not pay it twice. Two invoices are the same bill when they have the same `vendor_name`, the same `invoice_date` and the same `amount`.

Which invoices are the same bill as another one? List each such pair of invoice numbers.

End your reply with your answer as a fenced JSON block, exactly in this shape, with one pair per bill sent twice:

```json
{ "duplicates": [["INV-00000000", "INV-00000000"]] }
```
