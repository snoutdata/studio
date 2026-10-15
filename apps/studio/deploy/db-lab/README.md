# Database lab

Local, throwaway database servers for testing SnoutData Studio's drivers against the real
thing, without installing anything on the host. Needs Docker Desktop (or any Docker
engine with the `docker compose` plugin).

## Start / stop

```sh
# from apps/studio
docker compose -f deploy/db-lab/docker-compose.yml up -d      # start all engines
docker compose -f deploy/db-lab/docker-compose.yml ps         # see status
docker compose -f deploy/db-lab/docker-compose.yml logs -f    # watch (incl. seeding)
docker compose -f deploy/db-lab/docker-compose.yml down       # stop, keep data
docker compose -f deploy/db-lab/docker-compose.yml down -v    # stop + wipe data
```

Each engine is seeded once (on first start) with the same little schema: a `customers`
table and an `orders` table with a primary key, a foreign key and a secondary index, plus
a couple of rows. That exercises the explorer, completion/hover, query, grid-edit and
table-designer paths. Re-seed from scratch with `down -v` then `up -d`.

## Credentials

| Engine     | Host / Port      | Database | User    | Password         |
|------------|------------------|----------|---------|------------------|
| MySQL      | 127.0.0.1:3310   | `lab`    | `snout` | `snout`          |
| PostgreSQL | 127.0.0.1:5432   | `lab`    | `snout` | `snout`          |
| SQL Server | 127.0.0.1:1433   | `lab`    | `sa`    | `Snout_strong#1` |

The users are created when a volume is first initialised, so a lab started before these names
(2026-10-13) still has the old ones until it is re-created with `down -v`.

## Add a connection in the app

Run `npm run dev`, click "New Connection", pick the driver, and fill in the host/port/
database/user/password from the table above. The port auto-fills per driver. Leave SSL
off (these are plain local TCP) and the SSH tunnel off.

## Run the env-gated integration test against an engine

The integration test in `src/server/src/integration.test.ts` is parameterized by
`SNOUTDATA_IT_*` and skips when they're unset. Point it at a lab engine:

```sh
# MySQL
SNOUTDATA_IT_DRIVER=mysql-aurora SNOUTDATA_IT_HOST=127.0.0.1 SNOUTDATA_IT_PORT=3310 \
SNOUTDATA_IT_NAME=lab SNOUTDATA_IT_USER=snout SNOUTDATA_IT_PASSWORD=snout npm test

# PostgreSQL
SNOUTDATA_IT_DRIVER=postgres SNOUTDATA_IT_HOST=127.0.0.1 SNOUTDATA_IT_PORT=5432 \
SNOUTDATA_IT_NAME=lab SNOUTDATA_IT_USER=snout SNOUTDATA_IT_PASSWORD=snout npm test

# SQL Server
SNOUTDATA_IT_DRIVER=sqlserver SNOUTDATA_IT_HOST=127.0.0.1 SNOUTDATA_IT_PORT=1433 \
SNOUTDATA_IT_NAME=lab SNOUTDATA_IT_USER=sa SNOUTDATA_IT_PASSWORD='Snout_strong#1' npm test
```

The same variables run `src/server/src/readOnly.integration.test.ts`, which proves a read-only run
is refused by the DATABASE (a `SELECT` of a function that writes), a plain read still works, and the
pooled connection comes back writable. It creates and drops a `ro_probe` table and function. MySQL
needs to create a stored function with binary logging on, so run that one as root
(`SNOUTDATA_IT_USER=root SNOUTDATA_IT_PASSWORD=snout_root`). After `npm run server:build && npm run
server:tests`, run just that file with `node --test out/tests/server/src/readOnly.integration.test.js`.

On Windows PowerShell, set the vars with `$env:NAME = "value"` on separate lines before
`npm test` (the inline `VAR=val cmd` form is bash-only).

## Adding another engine later

Copy a service block in `docker-compose.yml`, give it a fresh published port and a named
volume, and drop a `seed/<engine>.sql` next to the others (MySQL/Postgres auto-run files
in `/docker-entrypoint-initdb.d`; an engine without that hook needs a one-shot init
service like `sqlserver-init`).
