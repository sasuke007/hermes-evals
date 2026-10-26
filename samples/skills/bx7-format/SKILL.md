---
name: bx7-format
version: 1.0.0
description: How to read BX-7 bank statement files (fixed-width lines, record types, amounts in cents, the direction column, reversals and reason codes), with a reader script, bx7.py.
---

# BX-7 statement files

Document reference: kv1-bx7-format, revision 3.

BX-7 is a fixed-width text format for bank account statements. This description covers every record a BX-7 file can hold, how to read an amount and its direction, and how to work out the balances. A reader for BX-7 files, `bx7.py`, ships with this description: for a file of more than a few dozen lines, run it rather than reading the lines by hand.

## Is it a BX-7 file?

The first line of a file is its header record, and columns 9 to 12 of the header hold the format id. A BX-7 file has the format id `BX07`. The format id decides which description applies, whatever the file is called: BX-7 files are usually named `*.bx7`, but an export can carry any name. A file with another format id, such as `BX06`, is not a BX-7 file, and nothing in this description applies to it.

## Lines and records

Every line is exactly 64 characters, followed by a line feed; unused columns hold spaces. Columns are numbered from 1. These columns are the same on every line:

| Columns | Field                                                                         |
| ------- | ----------------------------------------------------------------------------- |
| 1       | Record type: `A`, `B`, `E`, `F` or `Z`                                        |
| 2       | Part: `0` on the first line of a record, `1` to `9` on its continuation lines |
| 3-8     | Sequence number of the record, six digits; the header is `000001`             |

A record is one line, or one line followed by its continuation lines. A continuation line repeats the record type and the sequence number of the record it continues, and holds more of that record's text in columns 9 to 64. It is not a record of its own. Sequence numbers count records, not lines: each record's number is one more than the number of the record before it.

| Type | Record          | How many               |
| ---- | --------------- | ---------------------- |
| `A`  | Header          | One, the first record  |
| `B`  | Opening balance | One, the second record |
| `E`  | Movement        | Any number             |
| `F`  | Reversal        | Any number             |
| `Z`  | Trailer         | One, the last record   |

## The fields of each record

Dates are written as `YYYYMMDD`. Columns between the fields below that no field names hold spaces.

Header, `A`:

| Columns | Field                                                     |
| ------- | --------------------------------------------------------- |
| 9-12    | Format id: `BX07`                                         |
| 13-22   | Account number, ten digits                                |
| 23-25   | Currency of the account, for example `EUR`                |
| 26-33   | Statement date, the last day of the period, as `YYYYMMDD` |
| 34-41   | First day of the period, as `YYYYMMDD`                    |
| 42-64   | Free text                                                 |

Opening balance, `B`:

| Columns | Field                                                                 |
| ------- | --------------------------------------------------------------------- |
| 9-16    | Date of the balance: the first day of the period, before any movement |
| 17      | Direction                                                             |
| 18-31   | Amount                                                                |

Movement, `E`:

| Columns | Field                                                              |
| ------- | ------------------------------------------------------------------ |
| 9-16    | Booking date                                                       |
| 17      | Direction                                                          |
| 18-31   | Amount                                                             |
| 32-34   | Reason code                                                        |
| 35-46   | Bank reference                                                     |
| 47-64   | Text; longer text goes on in columns 9 to 64 of continuation lines |

Reversal, `F`:

| Columns | Field                                                 |
| ------- | ----------------------------------------------------- |
| 9-16    | Booking date                                          |
| 17      | Direction of the movement it reverses (see Reversals) |
| 18-31   | Amount reversed                                       |
| 32-34   | Reason code of the movement it reverses               |
| 35-40   | Sequence number of the movement it reverses           |
| 47-64   | Text, continued like a movement's                     |

Trailer, `Z`:

| Columns | Field                                                                                   |
| ------- | --------------------------------------------------------------------------------------- |
| 9-14    | Number of movement and reversal records in the file (records, not lines)                |
| 15-30   | Hash total: the sum of the amounts of those records, in cents, whatever their direction |

A record's text is the text of its first line followed directly by the text of each continuation line, with the spaces at its end removed.

## Amounts and direction

An amount is a whole number of cents in the currency of the account, written as fourteen digits with leading zeros: `00000000123456` is 1,234.56. The amount itself has no decimal point and no sign.

Column 17 gives the direction:

- `V`: the amount adds to the balance. Money in, a credit.
- `W`: the amount subtracts from the balance. Money out, a debit.

The opening balance uses the same letters: `V` for money in the account, `W` for an overdrawn account, a negative balance.

## Reversals

A reversal cancels an earlier movement of the same file, named by its sequence number in columns 35 to 40, in whole or in part: its own amount is what it cancels. Its direction column repeats the direction of the movement it reverses, so a reversal moves the balance the other way: an `F` record showing `V` takes its amount out of the balance, and one showing `W` puts its amount back.

## Balances

A BX-7 file has no closing balance record. The closing balance is the opening balance, plus each amount that adds to the balance and minus each amount that subtracts from it, over every movement and every reversal in the file. Money in is the total of the amounts that add (movements showing `V`, reversals showing `W`); money out is the total of the amounts that subtract (movements showing `W`, reversals showing `V`).

## Reason codes

Columns 32 to 34 of a movement hold its reason code: a letter and two digits. The letter does not tell a code's class; look every code up. Some common codes:

| Code  | Meaning                 | Class      |
| ----- | ----------------------- | ---------- |
| `C11` | Card purchase           | `card`     |
| `P20` | Supplier payment        | `payment`  |
| `R31` | Customer receipt        | `receipt`  |
| `K52` | Account maintenance fee | `fee`      |
| `N70` | Interest credited       | `interest` |

This is not the whole list. The full table, with the name and class of every code a BX-7 file can carry, is in `codes.md`.

## Example

A short statement (each line is padded with spaces to 64 characters; the padding is left out here):

```text
A0000001BX075550012345EUR2026013120260101MONTHLY STATEMENT
B000000220260101V00000000250000
E000000320260105V00000000120050R31K7Q2M4X9P1A3CUSTOMER RECEIPT I
E1000003NVOICE 2025-0912
E000000420260112W00000000008999C11B8N4T6R2W5Z7CARD STATIONERY
F000000520260114W00000000008999C11000004      REVERSAL
Z00000060000030000000000138048
```

The account opens at 2,500.00. Record 3 is a customer receipt of 1,200.50, whose text runs onto one continuation line: `CUSTOMER RECEIPT INVOICE 2025-0912`. Record 4 is a card purchase of 89.99, and record 5 reverses it in full: it shows `W`, the direction of record 4, so it puts 89.99 back. The file holds 6 records on 7 lines. Money in is 1,290.49, money out 89.99, and the closing balance 3,700.50. The trailer counts 3 movement and reversal records with a hash total of 1,380.48.

## The reader, bx7.py

`bx7.py` reads BX-7 files, with Python 3.9 or newer and nothing else, and checks each file against its trailer:

```text
python3 bx7.py FILE [FILE ...]            summary: records, opening and closing balance, money in and out
python3 bx7.py FILE [FILE ...] --by-code  the same, with the movements' totals per reason code
python3 bx7.py FILE [FILE ...] --records  the same, with every record listed
python3 bx7.py FILE [FILE ...] --json     the summary as JSON; with --records, every record too
```

It refuses a file whose format id is not `BX07`, and names any line it cannot read. It does not know the class of a reason code: look that up in `codes.md`.
