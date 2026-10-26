Ticket mcpv1-vendors-on-hold.

Our accounts-payable data is in two sources. The invoice database holds one record per invoice: `invoice_no`, `vendor_name`, `invoice_date`, `due_date`, `amount`, `currency`, `po_number`, `status` (`open`, `paid` or `disputed`) and `notes`. The vendor directory holds one entry per vendor: `name`, `vendor_id`, `payment_terms_days`, `status` (`active` or `on_hold`), `bank_country` and `notes`.

You have them either as tools, the `invoice-db` and `vendor-directory` MCP servers, or as files under `docs/` (`docs/invoices.csv` and `docs/vendors.json`), whichever you have.

Which vendors does the vendor directory list with the status `on_hold`? Give their names exactly as the directory spells them.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "on_hold": ["Vendor name"] }
```
