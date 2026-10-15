<p align="center">
  <img src="https://raw.githubusercontent.com/snoutdata/.github/main/assets/logo.png" alt="SnoutData" width="180" />
</p>

<h3 align="center">SnoutData Studio</h3>

<p align="center">
  A desktop workbench for every database and cloud log you already have, with your own coding agent running inside it.
</p>

<p align="center">
  <a href="https://github.com/snoutdata/studio/releases/latest"><img src="https://img.shields.io/github/v/release/snoutdata/studio?style=for-the-badge&label=Download&color=1c1c1c" alt="Download" /></a>
  <a href="https://github.com/snoutdata/studio/releases/latest"><img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-1c1c1c?style=for-the-badge" alt="Windows, macOS, Linux" /></a>
  <a href="https://github.com/snoutdata/studio/actions/workflows/ci.yml"><img src="https://github.com/snoutdata/studio/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="https://snoutdata.com/download">Download</a> ·
  <a href="https://docs.snoutdata.com">Docs</a> ·
  <a href="https://snoutdata.com">Website</a>
</p>

This repository is two things: the source of SnoutData Studio, under the
[Apache License 2.0](./LICENSE), and its release feed. The [releases](https://github.com/snoutdata/studio/releases)
hold the official installers, the update manifests the app reads, and the components it downloads on
demand. If you only want to use Studio, [install it](#download-and-install): the official build is
free, updates itself, and has everything described below plus the two parts that are not in this tree.

## What Studio is

An Electron app (React, Monaco, a SQL language server over LSP) for working with data:

- **Many database engines**: Postgres, MySQL, MariaDB, SQL Server, Oracle, Db2, SQLite, DuckDB,
  Snowflake, Redshift, SAP HANA, ClickHouse, MongoDB and more, with schema-aware completion and hover
  computed locally. Db2 and Snowflake are Windows (x64) only for now: their clients are downloaded on
  demand, and only a Windows x64 build of each is published.
- **Cloud logs as tables**: CloudWatch, Azure Monitor and Google Cloud logs, queried with SQL.
- **Your coding agent inside the app**: Claude Code, Codex and opencode run in a dock with your
  connections handed over through a local MCP server. The agent never receives your credentials;
  they stay encrypted with your OS keychain's key (on a Linux desktop with no keyring, in a file
  only your account can read, which Studio tells you once).
- **An AI assistant** that reads your live schema before it writes SQL.
- **Orbit** (your database as a 3D world), **Monitors** (live charts polled from your queries),
  **Move** (copy a database between your computer and SnoutData Cloud), schema diff, security admin
  and the workload advisor.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://docs.snoutdata.com/screenshots/agent-console.png"><img src="https://docs.snoutdata.com/screenshots/agent-console.png" alt="Claude Code running inside Studio and building a live dashboard" width="100%" /></a>
      <p><b>Your agent, in the app</b><br/><sub>Claude Code in the dock, asked for a dashboard, building it in the window.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="https://docs.snoutdata.com/screenshots/move-database.png"><img src="https://docs.snoutdata.com/screenshots/move-database.png" alt="Move a database: a local Postgres going into a new SnoutData Cloud project" width="100%" /></a>
      <p><b>Move a database</b><br/><sub>A local Postgres into a new cloud project, checked on both ends before anything is written.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://docs.snoutdata.com/screenshots/agent-build-report.png"><img src="https://docs.snoutdata.com/screenshots/agent-build-report.png" alt="The AI assistant building a multi-table sales report grounded in the real schema" width="100%" /></a>
      <p><b>SQL grounded in your schema</b><br/><sub>The assistant reads your live tables, columns and foreign keys before it writes SQL.</sub></p>
    </td>
    <td width="50%" valign="top">
      <a href="https://docs.snoutdata.com/screenshots/results-grid.png"><img src="https://docs.snoutdata.com/screenshots/results-grid.png" alt="The results grid paging through a large table" width="100%" /></a>
      <p><b>A grid built for big tables</b><br/><sub>Pages through millions of rows and edits cells inline.</sub></p>
    </td>
  </tr>
</table>

## Download and install

**Windows** 10/11: download `SnoutData-Setup-<version>.exe` from
[the latest release](https://github.com/snoutdata/studio/releases/latest) and run it. The installer is
signed, and Studio is also on the Microsoft Store.

**macOS** (Apple Silicon): download `SnoutData-<version>-arm64.dmg`, open it, and drag SnoutData into
Applications. Builds are signed and notarized.

**Linux** (Ubuntu, Debian): install the `.deb` from the release. It also adds SnoutData's signed apt
repository, so new versions arrive with `apt upgrade`.

On Windows and macOS the app updates itself from this repository's releases; on Linux, apt does.

## SnoutData Cloud

Studio works with any database; it also knows SnoutData Cloud, the backend for your own app: hosted
Postgres with auth, file storage, realtime, a REST and GraphQL API and your own TypeScript functions,
set up from a terminal with `npx snoutdata init`. Studio lists your Cloud projects beside your other
connections and moves a database in or out. One plan covers both, and either works without the
other. Start at [the docs](https://docs.snoutdata.com/cloud/getting-started); the CLI is
[`snoutdata` on npm](https://www.npmjs.com/package/snoutdata).

## What is not in this tree

Studio is open source except for two parts, which ship only in the official build and are free
there: **Data Flows** (bringing files, PDFs, web pages, buckets and log groups into a database;
running them on a schedule needs a paid plan) and **Liby**, the butterfly who is the assistant's
name and face. A build from this tree has everything else. Where Data Flows would be, it shows a short note
and a link to the download, and the assistant is simply called "AI". We keep Data Flows closed
because it is where most of our testing has gone, and Liby because she is a character and a
trademark rather than code to fork ([LIBY-LICENSE.md](./LIBY-LICENSE.md)). A source build also
sends no crash reports (no reporting address is compiled in) and no install or activity pings,
the "Remember this?" suggestions after a reply that proposes SQL are off until you name a model for them in
Settings, AI (each one is a second model call, and the official build uses an inexpensive model of
its own that a source build does not have), and it does not
update itself from the official feed: you update it by building it again. It is also its own app,
installed beside the official one rather than over it: a separate name, profile folder and app id,
no `snoutdata://` link handler (it signs in through a one-time listener on 127.0.0.1), and a Linux
package that adds no apt repository or key. The user documentation is at
[docs.snoutdata.com](https://docs.snoutdata.com), not in this repo.

Signing in and the AI assistant use SnoutData's online services, from a source build as from the
official one. Everything else (connecting, querying, completion, the agent console) works signed
out and talks only to the databases you configure, with one exception: a client the app does not
ship is downloaded the first time you use the database that needs it, and never before. The Db2,
Snowflake and DuckDB clients, the Node runtime the Db2 client runs in and the Postgres tools a
database move uses come from this repository's
[releases](https://github.com/snoutdata/studio/releases); IBM's Db2 driver comes from
IBM's download site; the SAP HANA client comes from SAP's `@sap/hana-client` package on npm. A
local project (Dashboard, Local) is made from the published stack at
[github.com/snoutdata/snout-stack](https://github.com/snoutdata/snout-stack), read from one pinned
commit. Each of these downloads is pinned to one file by a hash (Docker then pulls the images that
pinned `compose.yaml` names, by their tags), and the app shows IBM's and SAP's licences for you to
accept before it fetches anything of theirs. A build from source does the same: `npm ci` in this
repository installs neither vendor's client (the npm `ibm_db` package is left out because its
install script downloads IBM's driver), so `npm run dev` asks for the download, licence first, the
first time you connect to Db2 or SAP HANA.

## Build and run from source

You need **Node 22** (other major versions are not supported: the native modules are rebuilt for
Electron during install, and the Node version decides what that install downloads) and git. Some
native modules may compile from source, which needs Python 3 and a C++ toolchain: Xcode Command
Line Tools on macOS, Visual Studio Build Tools with the C++ workload on Windows, `build-essential`
on Linux.

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

A development run keeps no record of what the assistant sends and receives. To tune prompts, start it
with `SNOUT_AI_DEBUG=1 npm run dev`: every model round trip (the full prompt, which can include
schema and rows, and the reply) is then appended in plain text to `aiDebug.jsonl` in the app's data
folder, capped at 20 MB with one older file kept, and a token-protected tuning endpoint listens on
127.0.0.1. A packaged app never does either.

The end-to-end tests record a video of every window, which needs Playwright's ffmpeg: run
`npx playwright install ffmpeg` once first, or every launch waits and times out. On Linux without a
display, run them under `xvfb-run -a npm run e2e:app`.

## Layout

| Path | What it is |
|---|---|
| `apps/studio` | The app: `src/main` (Electron main), `src/preload`, `src/renderer` (React + Monaco), `src/server` (the SQL language server, run as a child process), `src/shared` (contracts and the engine every query and prompt passes through), `e2e` |
| `packages/review-core` | Rules that check a SQL migration against a live database, a library with no I/O |
| `packages/move` | Moving a database, shared with the `snoutdata` CLI |
| `packages/client` | `@snoutdata/client`, the JavaScript client for a SnoutData Cloud project, built from this source (also published to npm) |
| `packages/studio-pro-stub` | Stands in for Data Flows: the same interface, with only the placeholder behind it |
| `packages/liby-stub` | Stands in for Liby: every call is a no-op and nothing of hers is in it |

## Licence

This repository is under the [Apache License 2.0](./LICENSE). Third-party notices are in
[NOTICE](./NOTICE). The names and the logo are trademarks, and the licence does not grant them:
read [TRADEMARKS.md](./TRADEMARKS.md) before you distribute a build. Liby is covered by
[LIBY-LICENSE.md](./LIBY-LICENSE.md) and is not part of this repository.

Contributions are welcome: see [CONTRIBUTING.md](./CONTRIBUTING.md). Security problems go to
[SECURITY.md](./SECURITY.md), never to an issue.
