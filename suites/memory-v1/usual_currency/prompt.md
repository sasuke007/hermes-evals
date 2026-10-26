Ticket mv1-t01.

Your working directory contains `invoices.csv`, our accounts-payable ledger, in which each invoice is in its own currency, and `rates.json`, the exchange rates on 2026-10-20: how many units of each currency one GBP buys.

An invoice is unpaid when its `status` is `open`.

What do we owe in total on unpaid invoices, in my usual reporting currency? Convert each unpaid invoice at the rates in `rates.json`, add them up, and round the total once, to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "currency": "XXX", "total": 0.0 }
```
