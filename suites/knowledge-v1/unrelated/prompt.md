Your working directory contains `expenses.csv`, our team's expense claims: one row per claim, with its date, category, description and amount in EUR.

What did the team spend on travel in September 2026? Add up the `amount` of every claim whose `category` is `travel` and whose `date` falls in September 2026, rounded to the cent.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "travel_september": 0.0 }
```
