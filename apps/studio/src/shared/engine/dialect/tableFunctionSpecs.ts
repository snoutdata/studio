/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  WHICH table functions we know how to ask for, and what each one's arguments are.
 *
 *  A list and its shapes, with no imports, for the same reason `bulkFormats.ts` is separate from
 *  `bulkLoad.ts`: the dialect declares it (`index.ts`) and the code that uses it reads it back off
 *  the dialect, so keeping the data here is what stops those two importing each other.
 *
 *  The rules that shape the list are in `tableFunctions.ts`, which is where the statements are
 *  built. The one that matters while editing THIS file: an overload lives in its own `build`,
 *  because there is no way to skip a middle argument.
 *--------------------------------------------------------------------------------------------*/

/** What the person fills in. Keyed by {@link TableFunctionParam.name}. */
export type TableFunctionValues = Readonly<Record<string, string>>;

export interface TableFunctionParam {
	name: string;
	label: string;
	placeholder?: string;
	/** Without it the call cannot be built, and the actions say which one is missing. */
	required?: boolean;
	/** Never shown after it is typed, never recorded, never put in the editor. */
	secret?: boolean;
	/** Offer the engine's own formats instead of a text box (`bulkFormats`), with "let the
	 *  server work it out" as the empty choice. */
	format?: boolean;
	/** One line under the field, for the thing that is not obvious. */
	note?: string;
}

export interface TableFunctionSpec {
	/** The function's own name, sent verbatim. Never taken from anywhere but this file. */
	readonly id: string;
	/** What it is, in the words of someone who has the data rather than the docs. */
	readonly label: string;
	readonly summary: string;
	/** A codicon name for the list. */
	readonly icon: string;
	readonly params: readonly TableFunctionParam[];
	/**
	 * This function takes a key pair, so a saved cloud account can fill it in. The two names are
	 * the params the account's key id and its secret go into.
	 */
	readonly keyPair?: { readonly idParam: string; readonly secretParam: string };
	/** The ordered arguments for one call, as RAW values. The emitter quotes them. */
	build(values: TableFunctionValues): string[];
}

/** Trimmed value, or '' — a field of spaces is empty. Exported because every reading of a form's
 *  value, here and in `tableFunctions.ts`, has to agree about what empty means. */
export function paramValue(values: TableFunctionValues, name: string): string {
	return (values[name] ?? '').trim();
}

const v = paramValue;

/** `[a, b]` with the trailing empties dropped, for the functions whose last arguments are all
 *  optional and positional. */
function trimTail(args: string[]): string[] {
	const out = [...args];
	while (out.length > 0 && out[out.length - 1] === '') {
		out.pop();
	}
	return out;
}

/**
 * What a bucket read with no key pair says instead of a key pair.
 *
 * Not decoration: since 26.8 a server REFUSES to fall back on its own credentials for a user's
 * query, so leaving the two credential arguments out is an ACCESS_DENIED on a bucket that is
 * open to the world. This is the argument that says "do not sign this request at all", which is
 * what "a public bucket" has always meant here. Quoted like every other argument; the server
 * takes the keyword and the string alike.
 */
const NOSIGN = 'NOSIGN';

const FORMAT_PARAM: TableFunctionParam = {
	name: 'format',
	label: "Format",
	format: true,
	note: "Leave it unset and the server works it out from the file's name and contents.",
};

/**
 * The functions we know how to ask for, in the order the picker shows them.
 *
 * Not every one ClickHouse has: the ones whose arguments make a form somebody can fill in without
 * the documentation open. Whether a given server HAS one is its own answer, and it gives it the
 * moment the statement runs, which is a better error than any list we could keep up to date.
 */
export const CLICKHOUSE_TABLE_FUNCTIONS: readonly TableFunctionSpec[] = [
	{
		id: 's3',
		label: "Files in S3",
		summary: "One object or a whole pattern of them, read by the server straight from the bucket.",
		icon: 'package',
		params: [
			{ name: 'url', label: "URL", required: true, placeholder: 'https://bucket.s3.eu-west-1.amazonaws.com/events/2026/*.parquet', note: "A wildcard reads every object that matches, as one table." },
			{ name: 'keyId', label: "Access key id", note: "Leave both empty for a public bucket: the read goes unsigned." },
			{ name: 'secret', label: "Secret access key", secret: true },
			FORMAT_PARAM,
		],
		keyPair: { idParam: 'keyId', secretParam: 'secret' },
		build: (values) => {
			const url = v(values, 'url');
			const key = v(values, 'keyId');
			const secret = v(values, 'secret');
			return key || secret
				? trimTail([url, key, secret, v(values, 'format')])
				: trimTail([url, NOSIGN, v(values, 'format')]);
		},
	},
	{
		id: 'gcs',
		label: "Files in Google Cloud Storage",
		summary: "The same as S3, with GCS's own HMAC key.",
		icon: 'package',
		params: [
			{ name: 'url', label: "URL", required: true, placeholder: 'https://storage.googleapis.com/bucket/events/*.parquet' },
			{ name: 'keyId', label: "HMAC key", note: "An HMAC key, not a service account: the server signs an S3-style request." },
			{ name: 'secret', label: "HMAC secret", secret: true },
			FORMAT_PARAM,
		],
		keyPair: { idParam: 'keyId', secretParam: 'secret' },
		build: (values) => {
			const key = v(values, 'keyId');
			const secret = v(values, 'secret');
			return key || secret
				? trimTail([v(values, 'url'), key, secret, v(values, 'format')])
				: trimTail([v(values, 'url'), NOSIGN, v(values, 'format')]);
		},
	},
	{
		id: 'url',
		label: "A file over HTTP",
		summary: "Anything the server can fetch with a GET, read as a table.",
		icon: 'link',
		params: [
			{ name: 'url', label: "URL", required: true, placeholder: 'https://datasets.clickhouse.com/hits/hits.csv' },
			FORMAT_PARAM,
		],
		build: (values) => trimTail([v(values, 'url'), v(values, 'format')]),
	},
	{
		id: 'file',
		label: "A file on the server",
		summary: "A path inside the server's own user_files directory.",
		icon: 'file',
		params: [
			{ name: 'path', label: "Path", required: true, placeholder: 'events.parquet', note: "Relative to the SERVER's user_files directory, not to this computer." },
			FORMAT_PARAM,
		],
		build: (values) => trimTail([v(values, 'path'), v(values, 'format')]),
	},
	{
		id: 'remote',
		label: "Another ClickHouse server",
		summary: "A table on a different ClickHouse, read over its native port.",
		icon: 'server',
		params: [
			{ name: 'addresses', label: "Address", required: true, placeholder: 'other-host:9000', note: "One host, or a pattern like `host{01..04}:9000` for a set of them." },
			{ name: 'database', label: "Database", required: true, placeholder: 'default' },
			{ name: 'table', label: "Table", required: true, placeholder: 'events' },
			{ name: 'user', label: "User", placeholder: 'default' },
			{ name: 'password', label: "Password", secret: true },
		],
		build: (values) => trimTail([v(values, 'addresses'), v(values, 'database'), v(values, 'table'), v(values, 'user'), v(values, 'password')]),
	},
	{
		id: 'postgresql',
		label: "A Postgres table",
		summary: "Read straight out of Postgres, from the ClickHouse server.",
		icon: 'database',
		params: [
			{ name: 'address', label: "Host and port", required: true, placeholder: 'db.internal:5432' },
			{ name: 'database', label: "Database", required: true },
			{ name: 'table', label: "Table", required: true },
			{ name: 'user', label: "User", required: true },
			{ name: 'password', label: "Password", secret: true },
			{ name: 'schema', label: "Schema", placeholder: 'public', note: "Postgres has schemas and ClickHouse does not, so this one is its own argument." },
		],
		build: (values) => trimTail([
			v(values, 'address'), v(values, 'database'), v(values, 'table'),
			v(values, 'user'), v(values, 'password'), v(values, 'schema'),
		]),
	},
	{
		id: 'mysql',
		label: "A MySQL table",
		summary: "Read straight out of MySQL or MariaDB, from the ClickHouse server.",
		icon: 'database',
		params: [
			{ name: 'address', label: "Host and port", required: true, placeholder: 'db.internal:3306' },
			{ name: 'database', label: "Database", required: true },
			{ name: 'table', label: "Table", required: true },
			{ name: 'user', label: "User", required: true },
			{ name: 'password', label: "Password", secret: true },
		],
		build: (values) => trimTail([v(values, 'address'), v(values, 'database'), v(values, 'table'), v(values, 'user'), v(values, 'password')]),
	},
	{
		id: 'iceberg',
		label: "An Iceberg table",
		summary: "An Iceberg table in S3, read through its own metadata.",
		icon: 'layers',
		params: [
			{ name: 'url', label: "URL", required: true, placeholder: 'https://bucket.s3.eu-west-1.amazonaws.com/warehouse/db/events/' },
			{ name: 'keyId', label: "Access key id" },
			{ name: 'secret', label: "Secret access key", secret: true },
		],
		keyPair: { idParam: 'keyId', secretParam: 'secret' },
		build: (values) => trimTail([v(values, 'url'), v(values, 'keyId'), v(values, 'secret')]),
	},
	{
		id: 'deltaLake',
		label: "A Delta Lake table",
		summary: "A Delta table in S3, read through its transaction log.",
		icon: 'layers',
		params: [
			{ name: 'url', label: "URL", required: true, placeholder: 'https://bucket.s3.eu-west-1.amazonaws.com/warehouse/events/' },
			{ name: 'keyId', label: "Access key id" },
			{ name: 'secret', label: "Secret access key", secret: true },
		],
		keyPair: { idParam: 'keyId', secretParam: 'secret' },
		build: (values) => trimTail([v(values, 'url'), v(values, 'keyId'), v(values, 'secret')]),
	},
];
