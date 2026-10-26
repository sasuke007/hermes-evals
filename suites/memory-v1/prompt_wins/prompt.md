Ticket mv1-t04.

Your working directory contains `invoices.csv`, our accounts-payable ledger, in which each invoice is in its own currency, and `rates.json`, the exchange rates on 2026-10-20: how many units of each currency one GBP buys.

An invoice is unpaid when its `status` is `open`.

This figure is for our US auditors, so this time I need it in USD, whatever I usually report in. What do we owe in total on unpaid invoices, in USD? Convert each unpaid invoice at the rates in `rates.json`, add them up, and round the total once, to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "currency": "USD", "total": 0.0 }
```
