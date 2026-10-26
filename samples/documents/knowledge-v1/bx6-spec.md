# BX-6 statement files

Document reference: kv1-bx6-format, revision 5.

BX-6 is the fixed-width text format for bank account statements that the bank's systems wrote before the current one. Exports from older systems are often still BX-6 files. This description covers every record a BX-6 file can hold, how to read an amount and its direction, and how to work out the balances.

## Is it a BX-6 file?

The first line of a file is its header record, and columns 9 to 12 of the header hold the format id. A BX-6 file has the format id `BX06`. The format id decides which description applies, whatever the file is called: BX-6 files are usually named `*.bx`. A file with another format id is not a BX-6 file, and nothing in this description applies to it.

## Lines and records

Every line is exactly 64 characters, followed by a line feed; unused columns hold spaces. Columns are numbered from 1. These columns are the same on every line:

| Columns | Field                                                           |
| ------- | --------------------------------------------------------------- |
| 1       | Record type: `A`, `B`, `E` or `Z`                               |
| 2       | Reserved: always `0`                                            |
| 3-8     | Sequence number of the line, six digits; the header is `000001` |

| Type | Record          | How many             |
| ---- | --------------- | -------------------- |
| `A`  | Header          | One, the first line  |
| `B`  | Opening balance | One, the second line |
| `E`  | Movement        | Any number           |
| `Z`  | Trailer         | One, the last line   |

BX-6 has no reversal record: a payment that comes back is booked as a new movement in the other direction.

## The fields of each record

| Record | Columns | Field                                         |
| ------ | ------- | --------------------------------------------- |
| `A`    | 9-12    | Format id: `BX06`                             |
| `A`    | 13-22   | Account number, ten digits                    |
| `A`    | 23-25   | Currency of the account                       |
| `A`    | 26-33   | Statement date, as `YYYYMMDD`                 |
| `A`    | 34-41   | First day of the period, as `YYYYMMDD`        |
| `B`    | 9-16    | Date of the balance                           |
| `B`    | 17      | Direction                                     |
| `B`    | 18-31   | Amount                                        |
| `E`    | 9-16    | Booking date                                  |
| `E`    | 17      | Direction                                     |
| `E`    | 18-31   | Amount                                        |
| `E`    | 32-34   | Reason code                                   |
| `E`    | 35-46   | Bank reference                                |
| `E`    | 47-64   | Text                                          |
| `Z`    | 9-14    | Number of movements                           |
| `Z`    | 15-30   | Hash total: the sum of the movements' amounts |

## Amounts and direction

An amount is a whole number of thousandths of the currency unit, written as fourteen digits with leading zeros: `00000001234560` is 1,234.56. The amount itself has no decimal point and no sign.

Column 17 gives the direction:

- `W`: the amount adds to the balance. Money in, a credit.
- `V`: the amount subtracts from the balance. Money out, a debit.

The opening balance uses the same letters: `W` for money in the account, `V` for an overdrawn account.

## Balances

A BX-6 file has no closing balance record. The closing balance is the opening balance, plus the amounts of the movements showing `W`, minus the amounts of the movements showing `V`. Money in is the total of the movements showing `W`; money out is the total of the movements showing `V`.

## Reason codes

Columns 32 to 34 of a movement hold its reason code, three digits:

| Code  | Meaning          |
| ----- | ---------------- |
| `110` | Card purchase    |
| `210` | Supplier payment |
| `220` | Salary payment   |
| `310` | Customer receipt |
| `410` | Bank charge      |
| `510` | Interest         |
| `610` | Own-account move |
