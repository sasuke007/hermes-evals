Your working directory contains `ledger_view_2026_07.bx7`, a statement of our account exported from the bank's own ledger in the BX-7 statement file format.

That ledger records our account from the bank's side, so in this file the direction letters mean the opposite of what the BX-7 format says: `V` marks money leaving our account and `W` marks money arriving in it. Every other BX-7 rule applies as usual.

How much money arrived in our account over the period of ledger_view_2026_07.bx7, and how much left it? Give both as positive amounts in the account's currency, rounded to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "movements": { "money_in": 0.0, "money_out": 0.0 } }
```
