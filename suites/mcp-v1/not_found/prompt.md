Ticket mcpv1-not-found.

Our accounts-payable data is in two sources. The invoice database holds one record per invoice: `invoice_no`, `vendor_name`, `invoice_date`, `due_date`, `amount`, `currency`, `po_number`, `status` (`open`, `paid` or `disputed`) and `notes`. The vendor directory holds one entry per vendor: `name`, `vendor_id`, `payment_terms_days`, `status` (`active` or `on_hold`), `bank_country` and `notes`.

You have them either as tools, the `invoice-db` and `vendor-directory` MCP servers, or as files under `docs/` (`docs/invoices.csv` and `docs/vendors.json`), whichever you have.

What vendor and amount does the invoice database record for invoice INV-1131? If the database holds no invoice with that number, answer null instead of a record.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "record": { "vendor_name": "Vendor name", "amount": 0.0 } }
```
