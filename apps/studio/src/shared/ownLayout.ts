/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which names Studio speaks to a SnoutData door: its paths, its key header and its key names.
//
// Studio's code is written in our own layout: `/v1/data`, `/v1/identity`, `/v1/files`, `/v1/live`,
// `/v1/fn`, the `Snout-Key` header, the app key and the server key. A door not yet moved to those
// names is spoken to in the earlier layout, and the translation lives here and nowhere else, so
// moving a door over is one line in this file. Nothing about a request changes but its path and
// the name of its key header: same method, same body, same answer.

export type Vocabulary = 'new' | 'old';

/** The accounts backend (sign-in, plans, the control plane's functions): the new names are live
 *  there since 2026-10-15, the old ones still served beside them. */
export const ACCOUNTS_VOCABULARY: Vocabulary = 'new';

/** A cloud project's door, `<ref>.api.snoutdata.com`: the fleet serves the new names since 2026-10-15. */
export const CLOUD_VOCABULARY: Vocabulary = 'new';

/** A local project made from the snout-stack `localStack/plan.ts` pins (`STACK_COMMIT`), whose
 *  gateway serves the new names beside the old. A project made from an earlier pin runs the stack
 *  its own compose.yaml names, which may serve only the old ones: `stackVocabulary` says which. */
export const LOCAL_VOCABULARY: Vocabulary = 'new';

/** The first snout-stack release whose gateway serves the new names (0.1.5 was never published). */
const FIRST_NEW_STACK = [0, 1, 6] as const;

/**
 * What a local project's gateway speaks, from the snout-stack tag its compose.yaml runs: `old`
 * before 0.1.6, `new` from it on. A tag that is not a plain version (or none) is taken to be a
 * current stack.
 */
export function stackVocabulary(tag: string | null | undefined): Vocabulary {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '');
	if (!match) {
		return LOCAL_VOCABULARY;
	}
	const version = match.slice(1).map(Number);
	for (let i = 0; i < 3; i++) {
		if (version[i] !== FIRST_NEW_STACK[i]) {
			return version[i] > FIRST_NEW_STACK[i] ? 'new' : 'old';
		}
	}
	return 'new';
}

/** The vocabulary a project's gateway speaks, by where the project runs; a local project's own
 *  (`stackVocabulary`) when it is known. */
export function vocabularyFor(kind: 'local' | 'cloud', local: Vocabulary = LOCAL_VOCABULARY): Vocabulary {
	return kind === 'local' ? local : CLOUD_VOCABULARY;
}

export type Product = 'data' | 'graph' | 'identity' | 'files' | 'live' | 'fn';

/** Each product's prefix, ours then the earlier one. */
const PREFIXES: Record<Product, readonly [string, string]> = {
	data: ['/v1/data', '/rest/v1'],
	graph: ['/v1/graph', '/graphql/v1'],
	identity: ['/v1/identity', '/auth/v1'],
	files: ['/v1/files', '/storage/v1'],
	live: ['/v1/live', '/realtime/v1'],
	fn: ['/v1/fn', '/functions/v1'],
};

/**
 * Routes under a prefix that were renamed too, ours then the earlier one. Only the
 * routes Studio calls or shows: a word like `member` or `signed` is also a valid space name, so a
 * blanket map would send `/file/member/<path>` (a file in the space `member`) to another route.
 * Each entry matches a whole segment at the start of the route.
 */
const ROUTES: Partial<Record<Product, ReadonlyArray<readonly [string, string]>>> = {
	identity: [['/operator/people', '/admin/users'], ['/provider/return', '/callback']],
	files: [['/space', '/bucket'], ['/file', '/object']],
	live: [['/signal', '/api/broadcast']],
};

/** A product's prefix in `vocabulary`, for a URL a person reads. */
export function prefix(product: Product, vocabulary: Vocabulary): string {
	return PREFIXES[product][vocabulary === 'old' ? 1 : 0];
}

/** The header a door reads the key from: `Snout-Key`, earlier `apikey`. */
export function keyHeader(vocabulary: Vocabulary): string {
	return vocabulary === 'old' ? 'apikey' : 'Snout-Key';
}

function startsSegment(text: string, head: string): boolean {
	return text.startsWith(head) && (text.length === head.length || '/?#'.includes(text[head.length]));
}

/**
 * A gateway path written in our names (`/v1/files/space/avatars`), as `vocabulary` spells it
 * (`/storage/v1/bucket/avatars`). A path that does not start with one of our prefixes is returned
 * as it is, so the caller's own allowlist still decides what may be sent.
 */
export function wirePath(path: string, vocabulary: Vocabulary): string {
	if (vocabulary === 'new') {
		return path;
	}
	for (const product of Object.keys(PREFIXES) as Product[]) {
		const [ours, earlier] = PREFIXES[product];
		if (!startsSegment(path, ours)) {
			continue;
		}
		let rest = path.slice(ours.length);
		for (const [route, oldRoute] of ROUTES[product] ?? []) {
			if (startsSegment(rest, route)) {
				rest = oldRoute + rest.slice(route.length);
				break;
			}
		}
		return earlier + rest;
	}
	return path;
}

// ## The database's names
//
// A project's DATABASE has a layout of its own, which need not match its gateway's vocabulary: a
// project born before the new layout keeps the old one (auth, storage, realtime) until it is moved,
// whatever images it runs. So SQL the app writes against the platform's tables names them in our
// layout, and is spelled for the database it reaches after asking it which it is (`DB_LAYOUT_SQL`).

/** One row, `layout`: `new` when the database has the new layout's schemas, else `old`. */
export const DB_LAYOUT_SQL = `select case when to_regnamespace('snout_identity') is not null then 'new' else 'old' end as "layout"`;

/** The platform's tables the app reads, ours then the earlier name. Columns kept their names. */
const PLATFORM_TABLES: ReadonlyArray<readonly [string, string]> = [
	['snout_identity.people', 'auth.users'],
	['snout_identity.provider_links', 'auth.identities'],
	['snout_files.spaces', 'storage.buckets'],
	['snout_files.files', 'storage.objects'],
	['snout_live.listeners', 'realtime.subscription'],
];

/** App-written SQL that names the platform's tables in our layout, as a database in `layout` names
 *  them. Only those whole qualified names change; nothing else in the statement is touched. */
export function platformSql(sql: string, layout: Vocabulary): string {
	if (layout === 'new') {
		return sql;
	}
	let out = sql;
	for (const [ours, earlier] of PLATFORM_TABLES) {
		out = out.replace(new RegExp(`(?<![\\w."])${ours.replace('.', '\\.')}(?![\\w"])`, 'g'), earlier);
	}
	return out;
}
