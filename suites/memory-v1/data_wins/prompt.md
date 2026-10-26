Ticket mv1-t05.

Your working directory contains `invoices.csv`, this quarter's invoices from our vendors in Vessland with their net amounts in EUR, and `vat_rates.json`, the Vessland tax office's table of the standard VAT rate and the day each rate applies from.

Every invoice carries VAT at the standard rate in force on its invoice date.

How much VAT do these invoices carry in total? Round the total once, to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "vat_total": 0.0 }
```
