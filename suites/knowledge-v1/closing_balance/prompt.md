Your working directory contains `statement_2026_03.bx7`, a bank statement in the BX-7 statement file format.

What is the closing balance of statement_2026_03.bx7? The closing balance is the account's balance after every record in the file has been applied, in the account's currency, rounded to the cent. A negative balance (an overdrawn account) is a negative number.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "closing_balance": 0.0 }
```
