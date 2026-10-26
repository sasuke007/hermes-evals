Request tv1-reshape_json.

Your working directory contains `inventory.json`, our stock export: a list of warehouses, each with its bins, and in each bin the items it holds, each a stock-keeping unit (`sku`) and a quantity (`qty`). One SKU can sit in several bins, of one warehouse or of several.

Write `stock_by_sku.json` in the working directory: one JSON object with an entry for every SKU in `inventory.json`, keyed by the SKU exactly as the export writes it. Each entry is an object with exactly two keys:

- `total`: the SKU's quantity over every bin of every warehouse, as an integer;
- `warehouses`: an object with one key per warehouse that holds the SKU, its `code`, giving the SKU's quantity over all of that warehouse's bins.

For example, a SKU with 5 units in two bins of AMS and 2 in one bin of DUB:

```json
{
  "SKU-00000": {
    "total": 7,
    "warehouses": {
      "AMS": 5,
      "DUB": 2
    }
  }
}
```

End your reply with a fenced JSON block naming the file and its number of SKUs, exactly in this shape:

```json
{ "stock_file": "stock_by_sku.json", "skus": 0 }
```
