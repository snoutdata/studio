# @snout/review-core

The database pull-request reviewer, as a library. A diff goes in; findings and a markdown
comment come out. Optionally the destination's schema and the answers to some read-only
questions go in with it, and the findings stop being advice and start being measurements.

## The two rules this package exists to keep

1. **No I/O.** No network, no filesystem, no database, no dependencies. It is designed to run
   wherever a host puts it (the desktop app today, a CI runner or a service of your own) as the
   same code, and that is only true while this package cannot reach anything by itself.
2. **It decides, it does not fetch.** Everything it needs is passed in. When something is
   missing the rule stays quiet and the report records a **gap** — a reviewer that guesses is
   worse than one that says what it could not see.

## Using it

```ts
import { planReview, review, renderComment } from '@snout/review-core';

// 1. Static: a diff and nothing else. Works with no database anywhere near it.
const report = review({ diff });
console.log(renderComment(report));

// 2. Connected: ask what wants measuring, measure it, review with the answers.
const plan = planReview({ diff, schema, driverId: 'postgres' });
const probeResults = await Promise.all(
	plan.probes.map(async (probe) => ({
		id: probe.id,
		ok: true,
		rows: await runReadOnly(probe.sql), // your connection, your caps, your timeouts
	})),
);
const deep = review({ diff, schema, driverId: 'postgres', destinationName: 'staging', probeResults });
```

`schema` is structurally SnoutData's own `DatabaseSchema`, so the desktop app passes its
introspected schema straight in with no adapter.

## What a probe is

A read-only question for the destination, emitted by the core and run by the host:

```ts
{
  id: 's1x9-null-count-ship_date',
  statementId: 's1x9',
  kind: 'null-count',
  table: 'orders',
  cost: 'scan',
  purpose: 'whether `orders.ship_date` has NULLs, which would make SET NOT NULL fail',
  sql: 'SELECT COUNT(*) AS n FROM "orders" WHERE "ship_date" IS NULL',
}
```

Every probe is **read-only**, **aggregate-only** (a count, a maximum, a plan — never a row of
user data), and **declares its cost** so a host can refuse an expensive one on a huge table and
still have the report say what was skipped. `review.test.ts` asserts the read-only half rather
than trusting the comment.

## Layout

| File | Job |
| --- | --- |
| `branding.ts` | the only file with a product name in it |
| `types.ts` | findings, probes, review input/report, depth |
| `schema.ts` | the destination schema subset + index lookups |
| `dialect.ts` | the vendor differences a review decision turns on |
| `diff.ts` | unified diff → changed files + changed line numbers + path filtering |
| `statements.ts` | changed file → the statements the PR touched |
| `mention.ts` | comment body → command |
| `sql/tokenize.ts` | tolerant tokenizer (keeps quoted identifiers, unlike masking) |
| `sql/split.ts` | statement splitting with line numbers |
| `sql/parse.ts` | statement → structure (DDL actions, tables, predicates) |
| `sql/mask.ts` | literal/comment masking with paren depth |
| `rules/context.ts` | what a rule is handed; the PR's own pending schema changes |
| `rules/static.ts` | decidable from the text alone |
| `rules/schema.ts` | decidable once the destination is visible |
| `rules/plan.ts` | reading a vendor's EXPLAIN output |
| `probes.ts` | emitting probes, and reading them into "this will fail" |
| `report.ts` | findings → the comment, the help block, the check conclusion |
| `review.ts` | the orchestrator |

## Development

```
npm install
npm run build      # tsc → dist/
npm test           # tsc + node --test
npm run typecheck
```

Node 22+. Tests are `*.test.ts` beside their target and run from `dist/`.
