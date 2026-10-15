# Security

If you think you have found a security problem in SnoutData Studio, report it privately, never as
a public issue or pull request:

- a [private security advisory](https://github.com/snoutdata/studio/security/advisories/new) on
  this repository, or
- email **security@snoutdata.com**.

This covers the code in this repository and the official SnoutData Studio build, including the
parts of it that are not open source (Data Flows and Liby). Please include what you found, the
steps to reproduce it, the Studio version and platform, and a proof of concept if you have one. Do
not include anyone else's data, and do not test against accounts or databases that are not yours.

We acknowledge a report within 3 business days and aim to give a remediation timeline within 10
business days. Please give us a reasonable time to ship a fix before you disclose. We do not run a
paid bug bounty, but with your permission we credit reporters in the release notes.

The disclosure policy is [snoutdata/.github SECURITY.md](https://github.com/snoutdata/.github/blob/main/SECURITY.md)
(also linked from [snoutdata.com/.well-known/security.txt](https://snoutdata.com/.well-known/security.txt)).

## Supported versions

Only the latest release is supported. The official build updates itself, so a fix reaches users in
the next release. A build you made from source is updated by building it again from the latest
source.

## Out of scope

Problems in a database you connect Studio to, and in third-party software Studio uses (Electron,
Monaco, the database drivers): report those to that project. When you are not sure which it is,
send it to us and we will pass it on.
