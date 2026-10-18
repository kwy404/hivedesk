# My Data Script

Reads a CSV file, groups the rows by one column and sums another, then prints a table or JSON. The input file is never changed.

## Use

```sh
node bin/run.js data/sample.csv --by category --value amount
node bin/run.js data/sample.csv --by category --value amount --json > report.json
```

Rows with a wrong number of columns or without a number are reported on stderr with their line and skipped. Numbers like `1.234,56` and `1,234.56` both work.

## Develop

- `npm test` runs the tests (Node 20 or newer, no dependencies).
- `src/csv.js`: the CSV parser. `src/report.js`: the totals. `bin/run.js`: the command.
