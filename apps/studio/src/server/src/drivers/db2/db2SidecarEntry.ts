/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Db2 sidecar — runs in a **stock Node** child process, NOT in Electron.
 *
 * `ibm_db` is the only driver with a hard native dependency, and its prebuilt binary cannot run
 * under Electron's V8/ABI: the bundled `.node` is keyed to a stock-Node module version, and the
 * source cannot even be recompiled for Electron 42 (its `nan` shim calls the now-removed 2-arg
 * `v8::External::New`). So instead of loading `ibm_db` inside the Electron server child, we host it
 * here in a plain-Node process and the Electron-side {@link Db2Sidecar} proxies to it over stdio.
 *
 * Protocol: one JSON object per line on stdin (a request) and one per line on stdout (its reply).
 * stdout carries ONLY protocol frames; anything ibm_db / the clidriver prints is routed to stderr
 * so it never corrupts the channel. Requests: `open` (create/replace the pool), `query` (borrow →
 * run → release, one statement), `close` (drain the pool and exit). Replies echo the request `id`.
 *
 * `ibm_db` is required by the absolute path the parent resolves and passes in `SNOUTDATA_IBM_DB_PATH`,
 * so this script does not depend on its own cwd / node_modules layout (it runs from a temp copy).
 */

import type { Db2Connection, Db2Pool, IbmDb } from 'ibm_db';

interface Request {
	id: number;
	method: 'open' | 'query' | 'close';
	connStr?: string;
	sql?: string;
	params?: unknown[];
	maxPoolSize?: number;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ibmDbPath = process.env.SNOUTDATA_IBM_DB_PATH || 'ibm_db';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ibmdb = require(ibmDbPath) as IbmDb;

let pool: Db2Pool | undefined;
let connStr = '';

/** Write one reply frame. Always newline-terminated; the parent splits on newlines. */
function reply(frame: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(frame) + '\n');
}

function ok(id: number, extra?: Record<string, unknown>): void {
	reply({ id, ok: true, ...(extra ?? {}) });
}

function fail(id: number, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	// ibm_db decorates errors with `.sqlcode` / `.state`; pass them through so the parent can map a
	// preflight-dead connection (see deadConnection.ts) for its retry decision.
	const code = (err as { sqlcode?: unknown; state?: unknown } | null)?.state
		?? (err as { sqlcode?: unknown } | null)?.sqlcode;
	reply({ id, ok: false, error: message, code: code === undefined ? undefined : String(code) });
}

/** (Re)build the pool for a DSN. Closing any prior pool first makes `open` the reset primitive too. */
function openPool(req: Request): void {
	const next = new ibmdb.Pool();
	next.setMaxPoolSize(req.maxPoolSize ?? 4);
	const prior = pool;
	pool = next;
	connStr = req.connStr ?? '';
	if (prior) {
		prior.close(() => ok(req.id));
	} else {
		ok(req.id);
	}
}

/** Borrow a pooled connection, run one statement, release it, and reply with named-column rows. */
function runQuery(req: Request): void {
	if (!pool) {
		fail(req.id, new Error('db2 sidecar: not connected'));
		return;
	}
	pool.open(connStr, (openErr, conn: Db2Connection) => {
		if (openErr) {
			fail(req.id, openErr);
			return;
		}
		const done = (queryErr: Error | null, rows: Record<string, unknown>[]): void => {
			conn.close(() => undefined);
			if (queryErr) {
				fail(req.id, queryErr);
			} else {
				ok(req.id, { rows: rows ?? [] });
			}
		};
		try {
			if (req.params && req.params.length > 0) {
				conn.query(req.sql ?? '', req.params, done);
			} else {
				conn.query(req.sql ?? '', done);
			}
		} catch (err) {
			conn.close(() => undefined);
			fail(req.id, err);
		}
	});
}

function closePool(req: Request): void {
	const prior = pool;
	pool = undefined;
	if (prior) {
		prior.close(() => {
			ok(req.id);
			process.exit(0);
		});
	} else {
		ok(req.id);
		process.exit(0);
	}
}

function handle(req: Request): void {
	switch (req.method) {
		case 'open':
			openPool(req);
			break;
		case 'query':
			runQuery(req);
			break;
		case 'close':
			closePool(req);
			break;
		default:
			fail(req.id, new Error(`db2 sidecar: unknown method ${String((req as Request).method)}`));
	}
}

// Line-buffer stdin: requests are newline-delimited JSON.
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	buffer += chunk;
	let nl = buffer.indexOf('\n');
	while (nl !== -1) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (line) {
			try {
				handle(JSON.parse(line) as Request);
			} catch (err) {
				// A malformed frame has no id to echo; surface it on stderr for diagnosis.
				process.stderr.write(`db2 sidecar: bad frame: ${err instanceof Error ? err.message : String(err)}\n`);
			}
		}
		nl = buffer.indexOf('\n');
	}
});
// When the parent closes the pipe, exit rather than linger.
process.stdin.on('end', () => process.exit(0));
