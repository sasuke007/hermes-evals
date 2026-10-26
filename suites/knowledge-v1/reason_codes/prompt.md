Your working directory contains `statement_2026_05.bx7`, a bank statement in the BX-7 statement file format.

A fee is a movement whose reason code has the class `fee` in the BX-7 reason code table.

Which fee codes does statement_2026_05.bx7 use, and what is the total of each? Key each total by its reason code, and give it as a positive amount in the account's currency, rounded to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "fees_by_code": { "A00": 0.0 } }
```
