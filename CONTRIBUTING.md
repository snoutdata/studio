# Contributing

Thank you for helping. Bug fixes, new drivers, tests and small features are all welcome. For
anything large, open an issue first so we can agree on the shape before you write it.

## The Contributor License Agreement

Every pull request needs a signed Contributor License Agreement ([CLA.md](CLA.md)) before we can take
it. The first time you open one, the CLA bot comments with a sentence; you post it as a comment on
your pull request, and that signs it, once, for all your future pull requests here. If you contribute
for an employer that has rights in your work, make sure you have its permission, or ask us about a
corporate agreement at legal@snoutdata.com.

The CLA lets SnoutData Inc. license your contribution under other terms as well as Apache-2.0, for
example in the official SnoutData Studio build, which also contains parts that are not open source
(see the README). You keep the copyright in your work, and the version you contributed stays
available here under Apache-2.0.

## How a change gets in

This repository is published from SnoutData's main repository, which is private. Each commit here
is one change made there, copied across.

So a pull request here is not merged with the merge button. When we accept it, we apply your change
in the main repository with you as co-author (a `Co-authored-by:` line with your name and email),
and the next sync brings it back here as a commit that credits you. Your pull request is then
closed with a link to that commit. The change reaches users in the next official release.

## Before you open a pull request

Work from `apps/studio`, on Node 22 (the README has the setup, including the one-time
`npx playwright install ffmpeg` the end-to-end tests need):

```bash
npm run typecheck      # every project, including the build without the closed parts
npm test               # unit tests, about half a minute
npx playwright test <name> --project=app   # the end-to-end spec next to your change
```

Then, once, when the change is finished:

```bash
npm run e2e:app        # the whole end-to-end suite against the built app
```

CI runs the same checks on every push; a pull request with red CI is not reviewed until it is green.

- **Tests go beside their code**: a unit test is `name.test.ts` next to the file it tests and must
  run under plain Node (no Electron, DOM or Monaco imports). An end-to-end spec is
  `e2e/name.spec.ts`.
- **Integration tests against a real database** run only when the `SNOUTDATA_IT_*` (unit tier) or
  `SNOUTDATA_TEST_*` (end-to-end tier) variables point at one, and skip cleanly otherwise. If you
  touch a driver, run them against that database and say so in the pull request.
- **Style**: tabs, not spaces; braces on every block; `PascalCase` types and `camelCase` everything
  else. In text a user reads, no em-dashes. Colours, radii, shadows and durations come from the
  tokens at the top of `src/renderer/src/styles.css`, never a literal.
- **Nothing on the boot path**: work that is not needed for the first window is deferred, and a new
  view is loaded lazily, never imported statically from `App.tsx`.
- **Never include keys, passwords or connection strings**, in code, tests, fixtures or screenshots.

## What cannot be changed here

Data Flows and Liby are not in this tree (see the README), so a change to them cannot come through a
pull request here. Report a bug in either, or in the official build, with a
[bug report](https://github.com/snoutdata/snoutdata/issues/new?template=bug.yml) on the
`snoutdata/snoutdata` repository.

## Security

Security problems go to [SECURITY.md](./SECURITY.md), never to an issue or a pull request.

## Licence

By contributing you agree that your change is licensed under the [Apache License 2.0](./LICENSE),
like the rest of this repository, and under the terms of the CLA you signed.

Source files start with the repository's copyright header, then one blank line, written in the file
type's own comments: a `/* … */` block in TypeScript, JavaScript and CSS; `#` lines in shell, Python
and YAML (after a shebang); `--` lines in SQL; `;` lines in NSIS scripts; `REM` lines in batch files
(after `@echo off`); and a `<!-- … -->` comment in HTML and XML (after a doctype or XML declaration).
JSON and Markdown carry none, and neither do generated files or test fixtures that copy another
program's file format. A new file of those types gets it too: copy it from a file beside it. The
maintainers check every file for it before anything here is published.
