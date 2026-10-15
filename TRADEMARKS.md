# Trademarks

The code in this repository is yours to use, change and share under the
[Apache License 2.0](./LICENSE). Our names and logos are not. Section 6 of the licence says so
itself: it grants no permission to use the licensor's trade names, trademarks or product names.
This page says what that means in practice.

## Our marks

- **SnoutData**
- **SnoutData Studio**
- **Liby**, both the name and the character (the butterfly: her drawing, her 3D model and her
  likeness)
- the SnoutData logo and the Studio app icon, including the icon files under `build/` in this
  repository

They are trademarks of SNOUTDATA INC. The logo and icon files are in this repository only so the
official build can be made from it.

## Other companies' marks

Studio shows the marks of the coding agents it can open (Claude Code, OpenAI's Codex, opencode) on
the button that opens the user's own installed tool. They are their owners' trademarks, not ours,
and nothing in this repository's licence grants any right to them. Their appearance here does not
mean those companies endorse SnoutData or are affiliated with it.

## What you may do

- **Build and run Studio from this source** for yourself or inside your organisation, with our
  names and logo on it, as long as you use them unchanged. That condition is about the names and
  the logo only: the code is under the Apache License 2.0, and you may change it as you like.
- **Say what your work is based on**, truthfully: "a fork of SnoutData Studio", "based on SnoutData
  Studio", "works with SnoutData Cloud".
- **Refer to SnoutData** by name in articles, reviews, tutorials, talks and comparisons.

## What you may not do without our written permission

- **Distribute a build under our names or logo.** If you give a build to anyone outside your
  organisation, modified or not, give it a different name and replace the logo and the icon. Name
  yourself as its maintainer too: a build from this tree says `Built from source` as the Linux
  package's maintainer (`apps/studio/electron-builder.yml`) and as the package author
  (`apps/studio/package.json`), and a package you hand out should carry your own name and address
  there, never ours. A build from this tree is not the official SnoutData Studio (it lacks Data
  Flows and Liby), so calling it that would mislead the people who install it.
- **Use a name or logo that could be confused with ours**, for a product, a company, a domain, a
  package name or an app store listing.
- **Suggest that we made, endorse or support your build or service.**
- **Present anything as Liby**: no product, assistant or character shown to users under her name,
  and not her drawing, her model or a lookalike. She is not part of this repository;
  [LIBY-LICENSE.md](./LIBY-LICENSE.md) covers her. The identifiers, package names and file names in
  this repository's code that contain her name (`packages/liby-stub`, `libyFacts.ts` and the like)
  are code under the Apache License, and you may keep them as they are.

A build from this tree has no updater: it never checks our release feed and never installs from
it, and `npm run release`, which publishes to that feed, refuses to run in it. If your fork should
update itself, add an updater and a feed of your own (the `publish` block in
`apps/studio/electron-builder.yml` names ours), and your own release script.

## Asking

For anything not covered here, or to ask for permission, write to us through
[snoutdata.com/contact](https://snoutdata.com/contact).
