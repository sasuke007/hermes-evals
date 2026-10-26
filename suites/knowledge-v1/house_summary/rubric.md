# Method: the monthly statement review in the house style

The task asks for the monthly review of one BX-7 statement, written in the house style, with the title in `title` and the rest in `summary`. The reference answer is a review written to that style from the statement's own figures. The house style asks for:

- a title line `Statement review: account ending NNNN, Month YYYY`: the last four digits of the account number, then the full month name and the year of the statement date;
- dates written as `5 Jun 2026`: the day without a leading zero, the first three letters of the month, the year;
- amounts written as `EUR 12,345.60`, with money out and a negative balance as `EUR -1,200.00`;
- after the title, three bullet points in this order: the period with the opening and the closing balance; money in and money out, each with the number of movements behind it; the largest single movement out with its date; then a blank line and `Source: <file name>.`;
- no exclamation marks, and no "I" or "we".

Judge the reply's `title` and `summary` against these rules and against the reference's figures. Score from 0 to 1:

- **1.0**: every rule is followed and every figure equals the reference's.
- **0.7**: the title, the date and amount formats and the layout follow the style, with one figure wrong or one small slip in the wording.
- **0.3**: the figures are mostly right but the house style is not followed: another title, dates such as `2026-06-05`, amounts without the currency code in front, or another layout.
- **0.0**: no review, or figures with no relation to the statement.
