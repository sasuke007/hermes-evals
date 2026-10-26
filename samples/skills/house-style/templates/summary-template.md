# Template: statement review

Template reference: kv1-summary-template, revision 2.

Replace each part in angle brackets and keep every other word as it is. Dates and amounts follow the house style (`5 Mar 2026`, `EUR 12,345.60`, money out as `EUR -1,200.00`).

```text
Statement review: account ending <last four digits of the account>, <Month YYYY>

- Period <first day> to <last day>. Opening balance <amount>, closing balance <amount>.
- Money in <amount> over <number> movements. Money out <amount> over <number> movements.
- Largest movement out: <amount> on <date>.

Source: <file name>.
```

Count a movement once, whatever the number of lines it takes in the file. Money out is written with its minus sign.
