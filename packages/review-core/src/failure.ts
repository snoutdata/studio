/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Why a probe failed, in words the database did not write.
 *
 *  A probe's error is the database's own text, and the database echoes what it was asked about:
 *  a relation named `![x](https://evil/p.png) @org/team </details>` comes back inside the error,
 *  and the error used to go into the comment as is, under the user's name. It also carries
 *  hosts, roles and values that are nobody's business on a pull request. So the comment gets one
 *  of a few fixed sentences, chosen by the KIND of failure, and the text stays with the host.
 *
 *  Lexical, across Postgres, MySQL, SQL Server, Oracle, Db2, SQLite and ClickHouse, because no
 *  driver hands the host a structured code. A host that knows the kind (its own timeout, its own
 *  refusal) says so on `ProbeResult.failure` and this is not consulted.
 *--------------------------------------------------------------------------------------------*/

import type { ProbeFailure } from './types.js';

/** The one sentence the comment says for each kind. Never the database's words. */
export const PROBE_FAILURE_REASONS: Readonly<Record<ProbeFailure, string>> = {
	missing: 'the object does not exist on the target database',
	permission: 'permission denied',
	timeout: 'it timed out',
	resource: 'the database ran out of a resource it needed',
	refused: 'not run, because the read check refused it',
	'too-costly': 'not run, because the table is too large to count without cost',
	failed: 'the database could not run it',
};

// Ordered: the first match wins. Permission before "missing", since some engines answer a
// forbidden object with both words ("does not exist or you do not have permission").
const PATTERNS: ReadonlyArray<readonly [ProbeFailure, RegExp]> = [
	['permission', /permission denied|access denied|not authori[sz]ed|insufficient privilege|command denied|permission was denied|lacks? (?:the )?privilege|ora-01031|sql0551n|code: 497\b/i],
	['timeout', /timed?\s*out|timeout|took longer than|execution was interrupted|maximum statement execution time/i],
	['resource', /out of memory|insufficient system memory|memory limit|quota exceeded|exceeds the lock table size|too many (?:parts|simultaneous queries)/i],
	['missing', /does not exist|doesn't exist|unknown (?:table|column|database)|no such (?:table|column)|invalid (?:object|column) name|undefined (?:table|column)|ora-00942|ora-00904|sql0204n|sql0206n|code: (?:60|47)\b|unknown_table|unknown_identifier/i],
];

/** The kind of a probe failure, from the host's error text. */
export function probeFailureOf(error: string | undefined): ProbeFailure {
	const text = String(error ?? '');
	for (const [kind, pattern] of PATTERNS) {
		if (pattern.test(text)) {
			return kind;
		}
	}
	return 'failed';
}
