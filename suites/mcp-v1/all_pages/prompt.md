Ticket mcpv1-all-pages.

Our accounts-payable data is in two sources. The invoice database holds one record per invoice: `invoice_no`, `vendor_name`, `invoice_date`, `due_date`, `amount`, `currency`, `po_number`, `status` (`open`, `paid` or `disputed`) and `notes`. The vendor directory holds one entry per vendor: `name`, `vendor_id`, `payment_terms_days`, `status` (`active` or `on_hold`), `bank_country` and `notes`.

You have them either as tools, the `invoice-db` and `vendor-directory` MCP servers, or as files under `docs/` (`docs/invoices.csv` and `docs/vendors.json`), whichever you have.

What is the total amount of every invoice in the invoice database that is billed in EUR, whatever its status? Leave out the invoices billed in other currencies, and give the total rounded to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "total_eur": 0.0 }
```
