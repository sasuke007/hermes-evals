Ticket mcpv1-lookup-invoice.

Our accounts-payable data is in two sources. The invoice database holds one record per invoice: `invoice_no`, `vendor_name`, `invoice_date`, `due_date`, `amount`, `currency`, `po_number`, `status` (`open`, `paid` or `disputed`) and `notes`. The vendor directory holds one entry per vendor: `name`, `vendor_id`, `payment_terms_days`, `status` (`active` or `on_hold`), `bank_country` and `notes`.

You have them either as tools, the `invoice-db` and `vendor-directory` MCP servers, or as files under `docs/` (`docs/invoices.csv` and `docs/vendors.json`), whichever you have.

What does the invoice database record for invoice INV-1040? Give its vendor, dates, amount, currency, PO number and status exactly as recorded, with `po_number` or `due_date` null when the record has none.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{
  "invoice": {
    "invoice_no": "INV-0000",
    "vendor_name": "Vendor name",
    "invoice_date": "YYYY-MM-DD",
    "due_date": "YYYY-MM-DD",
    "amount": 0.0,
    "currency": "XXX",
    "po_number": "PO-0000",
    "status": "open"
  }
}
```
