Ticket mcpv1-due-by-terms.

Our accounts-payable data is in two sources. The invoice database holds one record per invoice: `invoice_no`, `vendor_name`, `invoice_date`, `due_date`, `amount`, `currency`, `po_number`, `status` (`open`, `paid` or `disputed`) and `notes`. The vendor directory holds one entry per vendor: `name`, `vendor_id`, `payment_terms_days`, `status` (`active` or `on_hold`), `bank_country` and `notes`.

You have them either as tools, the `invoice-db` and `vendor-directory` MCP servers, or as files under `docs/` (`docs/invoices.csv` and `docs/vendors.json`), whichever you have.

These 8 open invoices reached us without a due date: INV-1012, INV-1033, INV-1053, INV-1073, INV-1088, INV-1090, INV-1112 and INV-1113. Each one is due its vendor's payment terms after its invoice date: its `invoice_date` plus its vendor's `payment_terms_days` in the vendor directory, counted in calendar days.

What is the due date of each of them?

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "due_dates": { "INV-0000": "YYYY-MM-DD" } }
```
