---
name: house-style
version: 1.0.0
description: The house style for statement reviews and other short finance write-ups for the finance team, covering the title line, how dates and amounts are written, the layout and the tone.
---

# House style for statement reviews

Document reference: kv1-house-style, revision 2.

Write every review of a bank statement for the finance team in this style. Where a task gives its own instruction on a point, the task's instruction wins.

## Title

The first line is the title, and nothing else is on it:

```text
Statement review: account ending NNNN, Month YYYY
```

`NNNN` is the last four digits of the account number. `Month YYYY` is the full English name of the month of the statement date, then its year: `account ending 4417, March 2026`.

## Dates

In the text, write a date as the day of the month without a leading zero, the first three letters of the English month, and the year, separated by single spaces: `5 Mar 2026`, `28 Mar 2026`. Never write `2026-03-05`, `05/03/2026` or `March 5, 2026`.

## Amounts

Write the currency code, one space, then the amount with a comma between each group of three digits and two decimals: `EUR 12,345.60`. Money out, and a negative balance, take a minus sign after the space: `EUR -1,200.00`.

## Layout

After the title come exactly three points, as Markdown bullet points, in this order:

1. The period, from its first to its last day, with the opening and the closing balance.
2. Money in and money out over the period, each with the number of movements behind it.
3. The largest single movement out, with its date.

Then one blank line, and a last line naming the file the review was written from: `Source: <file name>.` The template `summary-template.md`, which ships with this style, shows the exact wording.

## Tone

Plain statements of fact. No exclamation marks, and no "I" or "we".
