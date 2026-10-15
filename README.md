<p align="center">
  <img src="https://raw.githubusercontent.com/snoutdata/.github/main/assets/logo.png" alt="SnoutData" width="132" />
</p>

<h1 align="center">SnoutData Studio</h1>

<p align="center">
  <b>A desktop IDE for every database you use, with your own coding agent working inside it.</b>
</p>

<p align="center">
  Postgres, Snowflake, MongoDB and your cloud logs in one window. Claude Code works with your
  connections without ever receiving a password, and the assistant reads your live schema before
  it writes a line of SQL.
</p>

<p align="center">
  <a href="https://github.com/snoutdata/studio/releases/latest"><img src="https://img.shields.io/github/v/release/snoutdata/studio?style=flat-square&label=download&color=1c1c1c" alt="Latest release" /></a>
  <a href="#install"><img src="https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-1c1c1c?style=flat-square" alt="Windows, macOS, Linux" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/snoutdata/studio?style=flat-square&color=1c1c1c" alt="Apache-2.0" /></a>
  <a href="https://github.com/snoutdata/studio/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/snoutdata/studio/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/snoutdata/studio/stargazers"><img src="https://img.shields.io/github/stars/snoutdata/studio?style=flat-square&color=1c1c1c" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="https://snoutdata.com/download"><b>Download</b></a> ·
  <a href="https://docs.snoutdata.com">Documentation</a> ·
  <a href="https://docs.snoutdata.com/changelog/">Changelog</a> ·
  <a href="https://snoutdata.com">Website</a>
</p>

<p align="center">
  <a href="https://docs.snoutdata.com/screenshots/agent-build-report.png"><img src="https://docs.snoutdata.com/screenshots/agent-build-report.png" alt="SnoutData Studio: the schema tree, a SQL editor and results grid, and the assistant writing a Q3 sales report from the real tables" width="100%" /></a>
</p>

## Why Studio

- **Your agent, in the app, with your databases.** Run Claude Code, Codex or opencode in a dock
  next to your queries. The agent asks Studio for data; it never gets your credentials.
- **AI that knows your schema.** The assistant picks the tables that matter to your question from
  your live schema, follows the foreign keys, runs read queries to check itself, and hands back
  SQL you can run, edit or drop into a tab.
- **One tool for every engine.** Relational databases, warehouses, MongoDB and cloud log services,
  all with the same editor, grid and assistant.
- **Fast and local where it counts.** Completion and hover come from a SQL language server running
  on your machine. Connecting, querying and the agent console work signed out.
- **Free, and open source.** The official build is free. This repository is its source, under
  Apache-2.0, except for two parts named [below](#what-is-not-in-this-tree).

## Highlights

### Your coding agent, working inside Studio

Claude Code, Codex and opencode each get their own console in a dock. Claude Code and Codex are
handed your connections as they start, through an MCP server Studio runs on 127.0.0.1, so "find out
why the orders page is slow" can actually look. Your passwords stay with Studio and are never
sent to the agent. Queries are read-only unless you allow writes for
that connection, and every call is in the Agent log. The agent can drive the app too: open tabs,
build a monitor, or show you what it found in a panel. Anything that changes the app asks you first.

### An assistant grounded in your real schema

Ask in plain words. Studio ranks your tables by relevance to the question, expands one hop along
foreign keys, and spends the prompt on the columns that matter, so a schema with hundreds of tables
still gets precise answers. In agentic mode it runs read queries to check its work. Ctrl/Cmd+K
edits or writes SQL in place; AI ghost-text completion is there when you switch it on. The
assistant runs on SnoutData's AI service (the free plan includes a monthly allowance), or on your
own OpenAI, Anthropic or OpenRouter key on a paid plan.

### Every engine you have, and your logs as tables

| | |
|---|---|
| **Relational** | PostgreSQL, MySQL (and Aurora), MariaDB, SQL Server, Oracle, IBM Db2, SQLite |
| **Analytics** | ClickHouse, DuckDB, Snowflake, Amazon Redshift, SAP HANA |
| **Documents** | MongoDB, queried with SQL or with its own aggregation pipeline |
| **Cloud logs** | AWS CloudWatch, Azure Monitor and Google Cloud Logging, each log a table you query with SQL |

Studio can also find what you already have: on first run it looks for databases on your computer,
in Docker containers, and in the saved connections of DBeaver, DataGrip, Navicat, pgAdmin, MySQL
Workbench, Azure Data Studio, SSMS, HeidiSQL, TablePlus and your `.pgpass`. SSH tunnels are built in.

### And more

- **Orbit**: your database as a 3D world. Tables are stars, foreign keys are the lines between
  them, and the tables a query touches light up as it runs.
- **Monitors**: live charts from your own SQL, polled on an interval, with trend widgets that keep
  their history between sessions.
- **Move a database**: copy a whole Postgres database between two connections, to or from
  SnoutData Cloud included, checked on both ends before anything is written.
- **A grid built for big tables**: keyset paging, so a deep page costs what the first one does; inline
  editing, foreign-key navigation, export to CSV, JSON and TSV.
- **Charts, schema diff with a migration preview, query performance and plan advice, and database
  users, roles and privileges** for Postgres, MySQL, MariaDB, SQL Server and Oracle.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://docs.snoutdata.com/screenshots/agent-console.png"><img src="https://docs.snoutdata.com/screenshots/agent-console.png" alt="Claude Code running in Studio's dock, showing its analysis of the orders table in a tab" width="100%" /></a>
      <p><b>Claude Code, in the app</b><br/><sub>Connected through Studio, showing what it found in a tab.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="https://snoutdata.com/blog/orbit-your-database-as-a-world"><img src="https://snoutdata.com/demo/orbit-hero-poster.png" alt="Orbit: a 500-table database drawn as a field of stars, with live queries listed in the corner" width="100%" /></a>
      <p><b>Orbit</b><br/><sub>500 objects and 1,987 relations, lit up by the queries you run.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://docs.snoutdata.com/screenshots/monitors.png"><img src="https://docs.snoutdata.com/screenshots/monitors.png" alt="A monitor with six live widgets: open orders, jobs by queue, revenue, orders by status" width="100%" /></a>
      <p><b>Monitors</b><br/><sub>Each widget is a query on a timer. Trends keep their history.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="https://docs.snoutdata.com/screenshots/mongodb-sql.png"><img src="https://docs.snoutdata.com/screenshots/mongodb-sql.png" alt="A SQL query against a MongoDB collection, with the results in the grid" width="100%" /></a>
      <p><b>MongoDB, in SQL</b><br/><sub>Or switch to the native pipeline. Same grid either way.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://docs.snoutdata.com/screenshots/move-database.png"><img src="https://docs.snoutdata.com/screenshots/move-database.png" alt="Moving a local Postgres database into a new SnoutData Cloud project" width="100%" /></a>
      <p><b>Move a database</b><br/><sub>A local Postgres into a new cloud project, preflighted on both ends.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="https://docs.snoutdata.com/screenshots/find-databases.png"><img src="https://docs.snoutdata.com/screenshots/find-databases.png" alt="The Find your databases dialog on first run" width="100%" /></a>
      <p><b>Find your databases</b><br/><sub>Picks up what is on your computer and in the tools you used before.</sub></p>
    </td>
  </tr>
</table>

## Install

| Platform | Download | Updates |
|---|---|---|
| **Windows** 10 and 11 (x64) | `SnoutData-Setup-<version>.exe`, signed. Also on the Microsoft Store. | In the app |
| **macOS** (Apple Silicon) | `SnoutData-<version>-arm64.dmg`, signed and notarized. Open it and drag SnoutData into Applications. | In the app |
| **Linux** (Ubuntu, Debian; x64) | `snoutdata_<version>_amd64.deb`. Installing it adds SnoutData's signed apt repository. | `apt upgrade` |

All three are on the [latest release](https://github.com/snoutdata/studio/releases/latest), or pick
yours at [snoutdata.com/download](https://snoutdata.com/download). The release page also carries
`SHA256SUMS`. Db2 and Snowflake currently work on Windows (x64) only, because their clients are
downloaded on demand and only a Windows x64 build of each is published.

## SnoutData Cloud

Studio works with any database. It also knows SnoutData Cloud, the backend for your own app: hosted
Postgres with auth, file storage, realtime, a REST and GraphQL API and your own TypeScript
functions, set up from a terminal with `npx snoutdata init`. Studio lists your Cloud projects beside
your other connections and moves a database in or out. Either works without the other. Start at
[the docs](https://docs.snoutdata.com/cloud/getting-started); the CLI is
[`snoutdata` on npm](https://www.npmjs.com/package/snoutdata).

---

## Open source

This repository is two things: the source of SnoutData Studio under the [Apache License 2.0](./LICENSE),
and its release feed. The [releases](https://github.com/snoutdata/studio/releases) hold the official
installers, the update manifests the app reads, and the components it downloads on demand.

### What is not in this tree

Two parts ship only in the official build, and are free there:

- **Data Flows**: bringing files, PDFs, web pages, buckets and log groups into a database (running
  them on a schedule needs a paid plan). We keep it closed because it is where most of our testing
  has gone.
- **Liby**, the butterfly who is the assistant's name and face. She is a character and a trademark
  rather than code to fork ([LIBY-LICENSE.md](./LIBY-LICENSE.md)).

A build from this tree has everything else. Where Data Flows would be, it shows a short note and a
link to the download, and the assistant is simply called "AI".

<details>
<summary><b>How a source build differs from the official one</b></summary>
<br/>

- It sends no crash reports (no reporting address is compiled in) and no install or activity pings.
- The "Remember this?" suggestions after a reply that proposes SQL are off until you name a model
  for them in Settings, AI. Each one is a second model call, and the official build uses an
  inexpensive model of its own that a source build does not have.
- It does not update itself from the official feed: you update it by building it again.
- It is its own app, installed beside the official one rather than over it: a separate name,
  profile folder and app id, no `snoutdata://` link handler (it signs in through a one-time listener
  on 127.0.0.1), and a Linux package that adds no apt repository or key.

</details>

<details>
<summary><b>What Studio talks to, and what it downloads</b></summary>
<br/>

Signing in and the AI assistant use SnoutData's online services, from a source build as from the
official one. Everything else (connecting, querying, completion, the agent console) works signed out
and talks only to the databases you configure, with one exception: a client the app does not ship
is downloaded the first time you use the database that needs it, and never before.

- The Db2, Snowflake and DuckDB clients, the Node runtime the Db2 client runs in, and the Postgres
  tools a database move uses come from this repository's
  [releases](https://github.com/snoutdata/studio/releases).
- IBM's Db2 driver comes from IBM's download site; the SAP HANA client comes from SAP's
  `@sap/hana-client` package on npm. The app shows IBM's and SAP's licences for you to accept before
  it fetches anything of theirs.
- A local project (Dashboard, Local) is made from the published stack at
  [github.com/snoutdata/snout-stack](https://github.com/snoutdata/snout-stack), read from one pinned
  commit.

Each of these downloads is pinned to one file by a hash (Docker then pulls the images that pinned
`compose.yaml` names, by their tags). A build from source does the same: `npm ci` installs neither
vendor's client (the npm `ibm_db` package is left out because its install script downloads IBM's
driver), so `npm run dev` asks for the download, licence first, the first time you connect to Db2
or SAP HANA.

</details>

### Build from source

You need **Node 22** and git. Other Node major versions are not supported: the native modules are
rebuilt for Electron during install, and the Node version decides what that install downloads. Some
native modules may compile from source, which needs Python 3 and a C++ toolchain (Xcode Command Line
Tools on macOS, Visual Studio Build Tools with the C++ workload on Windows, `build-essential` on
Linux).

```bash
git clone https://github.com/snoutdata/studio.git
cd studio/apps/studio
npm ci                 # also installs the packages under ../../packages
npm run dev            # starts the app with hot reload for the window
```

Other commands, all run from `apps/studio`:

```bash
npm run build          # build main, preload, the window and the SQL server into out/
npm run typecheck      # type-check every project
npm test               # unit tests (no database needed)
npm run e2e:app        # end-to-end tests: Playwright drives the real built app
npm run package:dir    # an unpacked, unsigned app under release/
```

<details>
<summary><b>Notes for development</b></summary>
<br/>

- A development run keeps no record of what the assistant sends and receives. To tune prompts, start
  it with `SNOUT_AI_DEBUG=1 npm run dev`: every model round trip (the full prompt, which can include
  schema and rows, and the reply) is then appended in plain text to `aiDebug.jsonl` in the app's
  data folder, capped at 20 MB with one older file kept, and a token-protected tuning endpoint
  listens on 127.0.0.1. A packaged app never does either.
- The end-to-end tests record a video of every window, which needs Playwright's ffmpeg: run
  `npx playwright install ffmpeg` once first, or every launch waits and times out. On Linux without
  a display, run them under `xvfb-run -a npm run e2e:app`.

</details>

### How it is built

An Electron app with a React and Monaco window. A SQL language server runs as a child process and
talks LSP; the window reaches it, and everything else that touches Node or the keychain, only
through the preload bridge. Every query and every prompt passes through one pure layer (parse,
dialect, guard, schema context) that runs unchanged in the window, the main process and the server.

| Path | What it is |
|---|---|
| `apps/studio` | The app: `src/main` (Electron main), `src/preload`, `src/renderer` (React + Monaco), `src/server` (the SQL language server), `src/shared` (contracts and the engine every query and prompt passes through), `e2e` |
| `packages/review-core` | Rules that check a SQL migration against a live database, a library with no I/O |
| `packages/move` | Moving a database, shared with the `snoutdata` CLI |
| `packages/client` | `@snoutdata/client`, the JavaScript client for a SnoutData Cloud project, built from this source (also published to npm) |
| `packages/studio-pro-stub` | Stands in for Data Flows: the same interface, with only the placeholder behind it |
| `packages/liby-stub` | Stands in for Liby: every call is a no-op and nothing of hers is in it |

### Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](./CONTRIBUTING.md). Security
problems go to [SECURITY.md](./SECURITY.md), never to an issue. User documentation lives at
[docs.snoutdata.com](https://docs.snoutdata.com), not in this repository.

If Studio is useful to you, a star helps other people find it.

### Licence

Apache License 2.0, see [LICENSE](./LICENSE). Third-party notices are in [NOTICE](./NOTICE). The
names and the logo are trademarks, and the licence does not grant them: read
[TRADEMARKS.md](./TRADEMARKS.md) before you distribute a build. Liby is covered by
[LIBY-LICENSE.md](./LIBY-LICENSE.md) and is not part of this repository.
