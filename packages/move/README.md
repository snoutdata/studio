# @snout/move

Moving a database from one place to another, written once and used by both the desktop app and
the `snoutdata` CLI.

- **The core** (`src/*.ts`) is pure: the `MoveSpec`, its validation, the strategy for a pair of
  engines, the preflight rules with their enumerated fixes, and the `pg_dump`/`pg_restore`
  arguments. No `node:` imports; `invariants.test.ts` fails the build if one appears.
- **The runner** (`src/runner/`, imported as `@snout/move/runner`; the desktop aliases it as
  `@snout/move-runner`) spawns `pg_dump | pg_restore`, polls the target's COPY progress, counts
  every table on both sides and reports. It is handed its host services (`MoveRunHost`): how to
  reach each end, how to run a statement, how to wake, create, export, pause or delete a hosted
  project, and where progress goes. `psqlQuery` is the statement runner for a host without a
  driver of its own, the CLI.

Nothing here ever holds a credential. A spec names endpoints; the host resolves them, and a
password only ever reaches a tool through its environment.

```
npm test
```

`src/runner/live.test.ts` moves a real database, and runs only when pointed at a server and the
tools:

```
SNOUT_MOVE_TEST_TOOLS=<Postgres 17 bin dir> SNOUT_MOVE_TEST_PG=<host>:<port>:<user>:<password> npm test
```
