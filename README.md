<div align="center">

<img src="icon.png" alt="SnoutData" width="128" height="128" />

# SnoutData

### Where your agents meet your data

A full-stack cloud backend to build on. A desktop workbench to explore your data and work with
coding agents.

**Helping thousands of developers to build their projects.**

[![Download](https://img.shields.io/github/v/release/snoutdata/app?style=for-the-badge&label=Download&color=1c1c1c)](https://github.com/snoutdata/app/releases/latest)
&nbsp;
[![Platform](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-1c1c1c?style=for-the-badge)](https://github.com/snoutdata/app/releases/latest)
&nbsp;
[![Docs](https://img.shields.io/badge/Docs-1c1c1c?style=for-the-badge)](https://docs.snoutdata.com)

</div>

---

This repository is the public release feed for **SnoutData Desktop**: the installers, the
auto-update manifests the app reads, and the components it downloads on demand. Grab a build from
[the latest release](https://github.com/snoutdata/app/releases/latest).

## Two products, one account

| | |
| --- | --- |
| **[SnoutData Cloud](https://snoutdata.com/cloud)** | Your app's backend: hosted Postgres with auth, file storage, realtime, a REST and GraphQL API and your own TypeScript functions, set up from a terminal with one command. |
| **[SnoutData Desktop](https://snoutdata.com/desktop)** | A workbench for every database and cloud log you already have, with your own coding agent running inside it. |

One plan covers both, and either works without the other.

<p align="center">
  <a href="https://raw.githubusercontent.com/snoutdata/app/main/assets/screenshots/orbit.png"><img src="https://raw.githubusercontent.com/snoutdata/app/main/assets/screenshots/orbit.png" alt="SnoutData Orbit drawing a 500-table Postgres database as a 3D world, with live queries moving through it" width="100%" /></a>
</p>
<p align="center"><b>Orbit: your database as a world, with the traffic on it</b><br/><sub>Every table a star, every foreign key a filament, and statements travelling the graph as they run.</sub></p>

## SnoutData Desktop

### Every database, one workbench
- **Relational:** PostgreSQL, MySQL and Amazon Aurora, MariaDB, SQL Server, Oracle, IBM Db2,
  SQLite, DuckDB, Snowflake, Amazon Redshift and SAP HANA.
- **Document and vector:** MongoDB and Pinecone, queried with the SQL you already know (transcribed
  to a native pipeline or vector query) or in their own language.
- **Cloud logs:** Amazon CloudWatch Logs, Azure Monitor Logs and Google Cloud Logging, where each
  log group is a table you query with SQL and read in a log reader.
- A schema-aware editor with completion and hover, a results grid that pages through millions of
  rows and edits cells inline, charts, live dashboards, schema diff, and index advice.

### Your coding agent, inside the app
- **Claude Code, Codex and opencode** run in a dock in SnoutData, in your workspace, with your
  connections handed over the moment they start. No `.env` file and no connection string in a repo.
- The agent **never receives your credentials**: it is handed capabilities, while passwords and
  keys stay in your operating system's keychain.
- It **drives the app**: opens tabs, builds dashboards, and draws results into the window instead
  of printing text. Anything that changes the app waits for your approval.
- Prefer your agent where it already lives? The same access is available over MCP.

### An assistant that knows your schema
- Ask in plain English and get SQL grounded in your real tables and foreign keys, dropped into the
  editor. Fix a failed query with the error and your schema in context.
- On Plus and Pro, bring your own OpenAI, OpenRouter or Anthropic key.

### Data flows
- Bring data in from **files and PDFs, web pages, other databases, Amazon S3 and S3-compatible
  storage** (Cloudflare R2, MinIO, Backblaze B2, Wasabi, Ceph) and **CloudWatch log groups**, then
  reshape it and land it in a table, a collection or a file.
- Typed columns proposed with reasons, the exact statements shown before they run, schedules that
  pick up new files and new events, and a ledger of every run.

### Orbit
- Your database drawn as a 3D world you fly through, clustered by schema. Hover a filament for the
  real constraint name; click a table to isolate its neighbourhood.
- **Pulse** draws the traffic: what this app ran, or, when you switch it on, what the whole database
  is running. No model is called on any frame.

### Move a database
- Copy a whole Postgres database between your computer and SnoutData Cloud, in either direction,
  into a database that already exists or one the move creates.
- Both ends are checked before anything runs, a copy of a hosted project is saved before it is
  replaced, and the report compares every table's row count on both sides.

## SnoutData Cloud

```bash
npx snoutdata login
npx snoutdata init --env        # a Postgres 17 database, and DATABASE_URL in .env
npx snoutdata functions deploy hello
```

- **Postgres 17 with pgvector**, reachable from anywhere over TLS, so any Postgres client works.
- **In front of it:** auth, file storage, realtime, a REST and GraphQL API, and Snout Functions,
  your own TypeScript. The client library your application is already written against works by
  changing one URL.
- **Built for agents:** every command takes `--json`, and `npx -y snoutdata mcp` serves the same
  operations as MCP tools to Codex, Claude Code or opencode.
- A free project sleeps when idle and wakes on the next connection. Auth, storage, realtime
  broadcast and functions are on every plan; the REST and GraphQL API and table-change
  subscriptions need a paid plan.
- We host your data and your project's password, encrypted. You can reveal or rotate it, and every
  change to a project is on your audit log. (Credentials that never leave your machine are the
  desktop app's promise, not the cloud's.)

SnoutData Cloud is in private testing: databases and functions are self-serve, and the rest is
switched on per project on request. Start at [dashboard.snoutdata.com](https://dashboard.snoutdata.com)
or read [the docs](https://docs.snoutdata.com/cloud/getting-started).

## Download and install

**Platforms:** Windows 10/11, macOS (Apple Silicon) and Linux (Ubuntu/Debian). The app keeps itself
up to date.

### Windows
Download **`SnoutData-Setup-<version>.exe`** and run it. The installer is signed, and SnoutData is
also on the Microsoft Store.

### macOS (Apple Silicon)
Download **`SnoutData-<version>-arm64.dmg`**, open it, and drag **SnoutData** into Applications.
Builds are signed and notarized.

### Linux (Ubuntu / Debian)
Download and install the `.deb`, or add the signed apt repository so new releases arrive with
`apt upgrade`:

```bash
curl -fsSL https://apt.snoutdata.com/snoutdata-archive-keyring.gpg \
  | sudo tee /usr/share/keyrings/snoutdata-archive-keyring.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/snoutdata-archive-keyring.gpg] https://apt.snoutdata.com stable main" \
  | sudo tee /etc/apt/sources.list.d/snoutdata.list >/dev/null
sudo apt update && sudo apt install snoutdata
```

## Screenshots

<sub>Click any screenshot to view it full size.</sub>

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://raw.githubusercontent.com/snoutdata/app/main/assets/screenshots/agent-console.png"><img src="https://raw.githubusercontent.com/snoutdata/app/main/assets/screenshots/agent-console.png" alt="Claude Code running inside SnoutData and building a live dashboard" width="100%" /></a>
      <p><b>Your agent, in the app</b><br/><sub>Claude Code in the dock, asked for a dashboard, building it in the window.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="https://raw.githubusercontent.com/snoutdata/app/main/assets/screenshots/move-database.png"><img src="https://raw.githubusercontent.com/snoutdata/app/main/assets/screenshots/move-database.png" alt="Move a database: a local Postgres going into a new SnoutData Cloud project" width="100%" /></a>
      <p><b>Move a database</b><br/><sub>A local Postgres into a new cloud project, checked on both ends before anything is written.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://raw.githubusercontent.com/snoutdata/app/main/assets/screenshots/agent-build-report.png"><img src="https://raw.githubusercontent.com/snoutdata/app/main/assets/screenshots/agent-build-report.png" alt="The AI assistant building a multi-table sales report grounded in the real schema" width="100%" /></a>
      <p><b>Ask in plain English, get schema-grounded SQL</b><br/><sub>The assistant reads your live tables, columns and foreign keys, and writes SQL that runs.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="https://raw.githubusercontent.com/snoutdata/app/main/assets/screenshots/table-telemetry.png"><img src="https://raw.githubusercontent.com/snoutdata/app/main/assets/screenshots/table-telemetry.png" alt="The per-table view showing storage, schema facts and recent queries" width="100%" /></a>
      <p><b>Know your tables at a glance</b><br/><sub>Storage and index sizes, keys and indexes, and the queries that recently touched it.</sub></p>
    </td>
  </tr>
</table>

## Links

- **Website:** [snoutdata.com](https://snoutdata.com), with plans and the [blog](https://snoutdata.com/blog)
- **Docs:** [docs.snoutdata.com](https://docs.snoutdata.com)
- **Cloud dashboard:** [dashboard.snoutdata.com](https://dashboard.snoutdata.com)
- **CLI:** [`snoutdata` on npm](https://www.npmjs.com/package/snoutdata)

---

<div align="center">
<sub>SnoutData · Where your agents meet your data · <a href="https://github.com/snoutdata/app/releases">Releases</a></sub>
</div>
