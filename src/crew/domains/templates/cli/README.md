# count

A small command line tool: counts lines, words and characters of files or of standard input.

## Use

```sh
node bin/cli.js notes.txt other.txt
cat notes.txt | node bin/cli.js --json
node bin/cli.js --help
```

`npm link` installs it as the `count` command. Errors go to stderr with exit code 1; unknown flags are rejected.

## Develop

- `npm test` runs the unit tests and spawns the CLI (Node 20 or newer, no dependencies).
- `src/lib.js` has the logic, `bin/cli.js` only parses flags and prints.
