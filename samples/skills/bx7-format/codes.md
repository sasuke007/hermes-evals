# BX-7 reason codes

Code table reference: kv1-bx7-codes, revision 3.

Every reason code a BX-7 movement or reversal can carry, with its name and its class. The class says what kind of movement a code is; the letter of a code does not. A reversal carries the code of the movement it reverses.

| Code | Name                              | Class      |
| ---- | --------------------------------- | ---------- |
| C11  | Card purchase                     | card       |
| C14  | Cash withdrawal by card           | card       |
| C19  | Card purchase in another currency | card       |
| K52  | Account maintenance fee           | fee        |
| K55  | Payment processing fee            | fee        |
| K58  | Card replacement fee              | fee        |
| K61  | Fee refund                        | refund     |
| K66  | Overdraft interest                | interest   |
| N70  | Interest credited                 | interest   |
| P20  | Supplier payment                  | payment    |
| P23  | Salary payment                    | payment    |
| P27  | Direct debit                      | payment    |
| R31  | Customer receipt                  | receipt    |
| R35  | Incoming transfer                 | receipt    |
| T40  | Transfer between own accounts     | transfer   |
| X81  | Withholding tax                   | tax        |
| X84  | Currency conversion charge        | fee        |
| Z90  | Bank correction                   | correction |

## Classes

- `card`: paid or withdrawn with a card of the account.
- `fee`: a charge the bank makes for its own services.
- `refund`: money the bank pays back, such as a fee charged in error.
- `interest`: interest the bank pays on the balance or charges on an overdraft.
- `payment`: money paid to someone else: a supplier, an employee, a direct debit.
- `receipt`: money received from someone else.
- `transfer`: money moved between the company's own accounts.
- `tax`: tax the bank withholds and pays on.
- `correction`: the bank correcting a booking error of its own.
