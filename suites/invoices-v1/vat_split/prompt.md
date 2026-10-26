Your working directory contains `invoices.csv`, our accounts-payable ledger, and `policy_terms.json`, which gives each vendor's VAT band and each band's rate. Every amount in `invoices.csv` is in EUR and net of VAT.

For this quarter's VAT return, take every invoice in the ledger, whatever its `status`. For each VAT band, add up the net amounts of its vendors' invoices, then compute the band's VAT on that total at the band's rate, rounded to the cent.

What are the net total and the VAT of each band, and the VAT of all bands together?

End your reply with your answer as a fenced JSON block, exactly in this shape, with one entry per VAT band that has invoices:

```json
{ "vat_bands": { "standard": { "net": 0.0, "vat": 0.0 } }, "total_vat": 0.0 }
```
