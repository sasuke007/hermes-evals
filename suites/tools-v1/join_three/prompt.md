Request tv1-join_three.

Your working directory contains three files from our order system:

- `orders.csv`: order lines, with `order_id`, `customer_id`, `sku` and `quantity`;
- `customers.csv`: our customers, with `customer_id`, `name` and `country` (a two-letter country code);
- `prices.csv`: unit prices in EUR, with `sku`, `unit_price` and `active`. When a price changes, the old row stays in the file with `active` set to `no`; the current price is the row whose `active` is `yes`, and every SKU has exactly one.

What is the total value of the order lines placed by customers whose `country` is `ES`, in EUR, rounded to the cent? An order line's value is its `quantity` times the current unit price of its `sku`.

End your reply with your answer as a fenced JSON block, exactly in this shape:

```json
{ "total_eur": 0.0 }
```
