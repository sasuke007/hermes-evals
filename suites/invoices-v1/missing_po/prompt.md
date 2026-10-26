Your working directory contains `invoices.csv`, our accounts-payable ledger, and `purchase_orders.csv`, every purchase order we have raised.

An invoice is backed by a purchase order when its `po_number` is listed in `purchase_orders.csv`. Consider every invoice, whatever its `status`.

Which invoices are not backed by a purchase order? Give their invoice numbers in ascending order, joined by commas with no spaces.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "missing_po": "INV-00000000,INV-00000000" }
```
