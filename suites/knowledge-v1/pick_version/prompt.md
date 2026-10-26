Your working directory contains `treasury_export.bx`, a bank statement file from our old treasury system's export folder, in one of the bank's BX statement file formats.

How much money went out of the account in treasury_export.bx? Give the total of every debit (money out) over the statement period, in the account's currency, rounded to the cent, as a positive number.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "money_out": 0.0 }
```
