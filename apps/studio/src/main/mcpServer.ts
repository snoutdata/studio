/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { agentHouseRules } from '../shared/agentHouseRules';

import type { DatabaseSchema } from '../shared/schema';
import {
	MCP_SERVER_NAME,
	type CliTokenErrorCode,
	type CliTokenRequestBody,
	type CliTokenResponse,
	type CliWhoamiResponse,
	type McpLockout,
	type McpLogInput,
} from '../shared/mcp';
import { capabilityConnectionArg, type CapabilityResult, type CapabilitySpec, type ImplicitConnection } from '../shared/capabilities';
import type { ExecuteQueryResult } from '../shared/protocol';
import type { ConnectionConfig } from '../shared/connection';
import { autoLimit, dataAccessRefusal, describeTable, effectiveDataAccess, gateValuesResult, valuesReducedBelowNeed, flavorFor, formatRows, qualified, readOnlyEnforcementFor, readOnlyError, type DataAccessLevel, type ToolAuditRecord } from '../shared/engine';

// A local MCP server (Streamable-HTTP transport, JSON responses) that exposes the app's
// connection broker to an external agent — Claude Code, or any MCP client. The agent gets a
// *capability* (run this read-only query against the connection named "prod-ro"), never a
// secret: credentials stay in the keychain and are resolved in main, exactly as for the app's
// own UI. This module is deliberately electron-free (node:http + node:crypto only) so it unit-tests
// under `node --test`; everything app-specific is injected via McpServerDeps.

const HOST = '127.0.0.1';
/** Cap request bodies so a stray client can't exhaust memory. */
const MAX_BODY = 1_000_000;

/** Where a capability's unnamed connection comes from, for a refusal an agent can relay. */
const IMPLICIT_WHERE: Record<ImplicitConnection, string> = {
	none: 'none',
	activeTab: 'the active editor tab\'s connection',
	result: 'the connection the result on screen came from',
	lastError: 'the connection the last error came from',
	target: 'the connections of what it names',
	perItem: 'each entry\'s own connection',
};
/** MCP protocol revision we implement; echoed back on initialize if the client doesn't pin one. */
const PROTOCOL_VERSION = '2025-06-18';
/** Path the JSON-RPC endpoint lives at. */
const ENDPOINT = '/mcp';
/**
 * The sign-in handoff: who is signed in, and a token of your own.
 *
 * Plain HTTP routes rather than MCP tools, deliberately. The tool list is FROZEN at connect,
 * so anything registered there has to be static and unconditional; and this is about the ACCOUNT,
 * not about a database, so it has to answer whether or not a single connection is on the allowlist.
 * Both point the same way: two routes beside `/mcp`, on the server that already exists, reached by
 * the port and token the caller already reads out of `userData/mcp.json`.
 */
const WHOAMI_ENDPOINT = '/cli/whoami';
const TOKEN_ENDPOINT = '/cli/token';
/**
 * `GET /cli/prove?nonce=<nonce>`: this app proves it holds the bearer token WITHOUT being sent it.
 *
 * The token lives in `userData/mcp.json` and the port is predictable, and a loopback port is not
 * per-user: another account can hold it while the app is closed. So a client that read the token
 * from that file must not send it to whatever answers there. It sends a fresh random nonce here
 * first, unauthenticated, and sends the bearer only if the answer is {@link studioProof} of that
 * nonce for the port it dialled. Only a holder of the token can compute it, the nonce makes an old
 * answer worthless, and the port in the proof stops one listener relaying another's.
 */
const PROVE_ENDPOINT = '/cli/prove';
/** What a client nonce may look like: base64url, 128 bits at least. */
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
/** The proof's domain, so an HMAC of this token for another purpose can never pass as one. */
export const STUDIO_PROOF_CONTEXT = 'snoutdata-studio-proof-v1';
/**
 * Wrong bearers (a token that was never issued here) tolerated from one remote address inside
 * {@link BAD_BEARER_WINDOW_MS} before that address is throttled for {@link LOCKOUT_MS}: a request
 * from it whose bearer is WRONG is refused with 429 until the cool-down ends. A bearer that was
 * issued and later replaced is a stale config, not a guess, and does not count.
 *
 * Only failing requests are throttled. Every local client, the person's own agents included, comes
 * from 127.0.0.1, so refusing the ADDRESS would let any program keep those agents out for as long as
 * it kept guessing (five wrong bearers every five minutes would do it). A request with the right
 * token is always served, and the proof endpoint always answers, whatever else that address sent.
 * A guess costs the guesser a 429 and gets no answer either way; the token is 256 bits, so the
 * throttle is a signal to the person rather than the thing that stops a guess.
 *
 * The token is NEVER rotated here. Rotating on wrong bearers let any local process break every
 * config the person had pasted, at will. The app is told (`onLockout`) and offers a rotation, which
 * only the person can start.
 */
export const BAD_BEARER_LIMIT = 5;
export const BAD_BEARER_WINDOW_MS = 10 * 60_000;
export const LOCKOUT_MS = 5 * 60_000;

/** The configured port is held by something else: the broker did not start, and did not move. */
export class McpPortInUseError extends Error {
	constructor(public readonly port: number) {
		super(`Port ${port} on 127.0.0.1 is already in use by another program.`);
		this.name = 'McpPortInUseError';
	}
}

/**
 * Is `port` on 127.0.0.1 free for the broker: nothing answers a connection there, and it can be
 * bound. Both, because a bind test alone passes a port another program holds on a different
 * address, and the broker's clients dial 127.0.0.1.
 */
export async function loopbackPortFree(port: number): Promise<boolean> {
	const answers = await new Promise<boolean>((resolve) => {
		const socket = connect({ host: HOST, port });
		const done = (value: boolean): void => {
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(500, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
	if (answers) {
		return false;
	}
	return new Promise<boolean>((resolve) => {
		const probe = createNetServer();
		probe.once('error', () => resolve(false));
		probe.listen(port, HOST, () => probe.close(() => resolve(true)));
	});
}

/** The first port above `taken` (within a small range) that {@link loopbackPortFree} passes, or null. */
export async function nextFreeLoopbackPort(taken: number, isFree: (port: number) => Promise<boolean> = loopbackPortFree): Promise<number | null> {
	for (let port = taken + 1; port <= Math.min(taken + PORT_SCAN, 65535); port++) {
		if (await isFree(port)) {
			return port;
		}
	}
	return null;
}

/** The proof of holding `token`, for one client nonce, on the port the client dialled. */
export function studioProof(token: string, port: number, nonce: string): string {
	return createHmac('sha256', token).update(`${STUDIO_PROOF_CONTEXT}\n${port}\n${nonce}`).digest('base64url');
}
/** How many ports above a taken one to look at when suggesting another (never walked to by itself). */
const PORT_SCAN = 20;

const DEFAULT_MAX_ROWS = 200;
const MAX_MAX_ROWS = 1000;
const MAX_TABLE_LINES = 500;
const MAX_COLUMN_HITS = 200;

/** One configured connection as the server sees it (allowed = on the MCP allowlist). */
export interface McpConnectionRef {
	id: string;
	label: string;
	driver: string;
	/** The engine by name when it differs from the driver's (CockroachDB on `postgres`). */
	engine?: string;
	/** The connection's flavor id, for the read check (TiDB on `mysql-aurora` is checked strictly). */
	flavor?: string;
	environment?: string;
	readOnly?: boolean;
	allowed: boolean;
	/** Writes/DDL permitted over MCP for this connection (off by default; see McpStore.allowWrites). */
	writes: boolean;
	/** What the database itself enforces for a read on this connection (`readOnlyEnforcementFor`). */
	readOnlyBy: string;
}

/**
 * The saved connections, as the broker sees them.
 *
 * A pure function rather than a lambda in `index.ts` because of what it must keep NOT
 * doing. Every saved connection is listed the same way whatever it is and wherever it
 * came from, and `McpConnectionRef` carries no field that could say — so a database
 * imported from SnoutData Cloud reaches an agent exactly as a hand-made one does, with no branch
 * anywhere to get wrong.
 *
 * **`allowed` comes from the allowlist and from nothing else, and that is the line to
 * hold.** The broker is opt-in per connection and off by default, and it is tempting to exempt a
 * hosted database on the grounds that the user's own cloud account is not really a third party. It
 * is exactly as much a third party: an agent reading it reads the customer's data, and "zero setup"
 * for the agent console means no credential to plumb, never no permission to ask. A test asserts a
 * cloud-imported connection is not allowed by default.
 *
 * The password is not here and could not be: it lives in the keychain and is resolved in
 * main at connect time, so the broker executes queries and the agent receives rows.
 */
export function toConnectionRefs(
	configs: readonly ConnectionConfig[],
	isAllowed: (id: string) => boolean,
	isWriteAllowed: (id: string) => boolean,
): McpConnectionRef[] {
	return configs.map((c) => ({
		id: c.id,
		label: c.label,
		driver: c.driver,
		engine: flavorFor(c.driver, c.flavor)?.displayName,
		flavor: c.flavor,
		environment: c.environment,
		readOnly: c.readOnly,
		allowed: isAllowed(c.id),
		writes: isWriteAllowed(c.id),
		readOnlyBy: readOnlyEnforcementFor(c.driver, c.flavor).summary,
	}));
}

/** Everything the server needs from the rest of the app, injected so this stays electron-free. */
export interface McpServerDeps {
	serverInfo: { name: string; version: string };
	/** The current bearer token; compared (timing-safe) against the request's Authorization header. */
	token(): string;
	/**
	 * Was this bearer once the token here, since replaced? A stale config sends one; it is refused
	 * like any wrong bearer but does not count toward a lockout. Absent ⇒ every wrong bearer counts.
	 */
	isRetiredToken?(bearer: string): boolean;
	/**
	 * A remote address sent {@link BAD_BEARER_LIMIT} wrong bearers and is now refused until
	 * `until`. The app tells the person and offers to replace the token; it never does so itself.
	 */
	onLockout?(lockout: McpLockout): void;
	/** Every configured connection plus whether it's exposed to agents. */
	connections(): McpConnectionRef[];
	/** Ensure the connection is live, then return its cached schema (null if unavailable). */
	resolveSchema(id: string): Promise<DatabaseSchema | null>;
	/** Ensure the connection is live, then run one statement. `readOnly`: the statement passed the
	 *  read-only check and the database is asked to refuse writes too (`readOnlyEnforcement`). */
	execute(id: string, sql: string, options?: { readOnly?: boolean }): Promise<ExecuteQueryResult>;
	/** Record an executed agent query to the MCP log (separate from the user's query history). */
	log(entry: McpLogInput): void;
	/**
	 * Record one agent tool call to the *AI audit trail* — the same log the chat path writes to,
	 * so "every mediated action lands in one place" is true for the least-supervised path too.
	 * This is deliberately separate from {@link log}: the MCP log is the user-facing Agent log of
	 * executed SQL, while this is the audit record with origin/mutates/duration. Absent ⇒ audit
	 * recording is off.
	 * `client` is the agent's self-reported name from `initialize`.
	 */
	audit?(record: ToolAuditRecord, client: string): void;
	/** Injected clock, so audit durations are deterministic under test. Defaults to `Date.now`. */
	clock?(): number;
	/**
	 * The app's own capabilities, published by the renderer.
	 * These become TOOLS alongside the database ones, which is what lets an agent act on the app's
	 * SCREEN (open a tab, run a query into the grid, change a setting) rather than only read a
	 * database. Absent ⇒ this build exposes database tools only.
	 */
	capabilities?(): CapabilitySpec[];
	/** Run one capability in the renderer and return its result. Required for the above. `client`
	 *  is the agent's self-reported name, so an approval prompt can say who is asking.
	 *  `expectConnections`, when given, are the connections checked for this call: the app refuses
	 *  to run it if what it acts on has changed since. */
	invokeCapability?(name: string, args: Record<string, unknown>, client: string, expectConnections?: string[]): Promise<CapabilityResult>;
	/**
	 * Ask the app, WITHOUT running anything, which connections a capability would act on that the
	 * call does not name (the active tab's, the result grid's, the last error's, those of the flow or
	 * project it names), as `connectionIds`. Absent ⇒ such a capability is refused, since nobody can
	 * say whether its connection is exposed.
	 */
	resolveCapabilityConnections?(name: string, args: Record<string, unknown>, client: string): Promise<CapabilityResult>;
	/**
	 * Whether an agent may run capabilities that CHANGE the app. Default OFF: a read-only
	 * capability runs with no prompt, anything that mutates needs the user's answer. Off no longer
	 * means REFUSED: the invoker asks the user, and the card says that allowing turns the feature
	 * on. This is reported to the agent by `list_app_actions` so it knows what it is asking for.
	 * Absent ⇒ treated as off.
	 */
	allowMutatingCapabilities?(): boolean;
	/**
	 * What the AI may see of a database, the same setting the assistant obeys (Settings → AI;
	 * engine/context/dataAccess.ts). A tool that would hand the agent values the level does not
	 * allow is REFUSED rather than hidden, because the tool list is frozen at `initialize` and the
	 * user may change the level mid-session. Given a connection id, the level for that database (its
	 * own setting, else the default); with none, the default. Absent ⇒ the default level.
	 */
	dataAccess?(connectionId?: string): DataAccessLevel | undefined;
	/** The app-changing actions that already have a standing yes, so `list_app_actions` can say
	 *  which ones run without interrupting the user. Absent ⇒ none are assumed. */
	autoApprovedCapabilities?(): string[];

	/* --- The sign-in handoff. See WHOAMI_ENDPOINT above. --- */

	/** This computer's name, for the whoami answer and the minted token's name. Absent ⇒ unnamed. */
	machine?(): string;
	/**
	 * The signed-in account's email, or null when nobody is signed in. NEVER the session, and
	 * nothing that could stand in for one. Absent ⇒ this build reports signed out.
	 */
	account?(): string | null;
	/** Whether the user has left the handoff switched on (McpStore.signInHandoff). Absent ⇒ on. */
	signInHandoff?(): boolean;
	/**
	 * Ask the person at this computer, and on a yes mint an `sdt_` token through the control plane.
	 *
	 * The whole of "mint, never lend" lives on the other side of this function: it MINTS, so what
	 * comes back is a fresh credential that appears in `snoutdata tokens list`, is revocable, and
	 * lands on the audit log as itself. Lending the app's session instead would hand over the user's entire
	 * login with no way to see it or take it back, so no shape of this dep returns one.
	 *
	 * Absent ⇒ the mint endpoint answers `not-ready`.
	 */
	mintCliToken?(request: { client: string; command?: string }): Promise<CliTokenResponse>;
}

interface ToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/**
	 * MCP's tool annotations. `readOnlyHint` is what a client uses to decide whether a call needs the
	 * user's approval on ITS side: Codex refuses any unannotated tool outright under `codex exec`
	 * ("requires approval, but approval policy is never"), which is how it was found (2026-09-21).
	 * They are hints about the tool, not permissions: the app still gates every change itself.
	 */
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

const READ_ONLY = { readOnlyHint: true } as const;

const CONNECTION_PROP = { connection: { type: 'string', description: 'A connection label or id, as listed by list_connections.' } };

const TOOLS: ToolDef[] = [
	{
		name: 'list_connections',
		description: 'List the database connections this SnoutData user has exposed to agents (name, driver, environment, whether read-only). Use a name from here as the "connection" argument to the other tools.',
		inputSchema: { type: 'object', properties: {} },
		annotations: READ_ONLY,
	},
	{
		name: 'list_tables',
		description: 'List the tables and views in a connected database (names, kind, column count). Use a filter on large databases.',
		inputSchema: { type: 'object', properties: { ...CONNECTION_PROP, filter: { type: 'string', description: 'Optional case-insensitive substring to filter table names.' } }, required: ['connection'] },
		annotations: READ_ONLY,
	},
	{
		name: 'describe_table',
		description: "Get a table's columns, types, primary key, foreign keys and indexes. Call this before writing SQL against a table.",
		inputSchema: { type: 'object', properties: { ...CONNECTION_PROP, table: { type: 'string', description: 'Table name, optionally schema-qualified (e.g. "orders" or "public.orders").' } }, required: ['connection', 'table'] },
		annotations: READ_ONLY,
	},
	{
		name: 'search_columns',
		description: 'Find tables and columns whose name contains a term, across the whole schema. Useful when you do not know which table holds a field.',
		inputSchema: { type: 'object', properties: { ...CONNECTION_PROP, term: { type: 'string', description: 'Substring to search for in table and column names.' } }, required: ['connection', 'term'] },
		annotations: READ_ONLY,
	},
	{
		name: 'run_query',
		description: 'Run a single SQL statement and return the rows. Read-only by default (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN); writes and DDL are refused unless the user has explicitly enabled writes for this connection. A statement is checked before it runs, and on most engines the database itself is also asked to refuse writes for that query; list_connections says what each connection enforces. Results are row-limited; pass maxRows to adjust (capped). Do not add a trailing semicolon or multiple statements.',
		inputSchema: { type: 'object', properties: { ...CONNECTION_PROP, sql: { type: 'string', description: 'One SQL statement.' }, maxRows: { type: 'number', description: `Optional row cap for SELECTs (default ${DEFAULT_MAX_ROWS}, max ${MAX_MAX_ROWS}).` } }, required: ['connection', 'sql'] },
	},
	{
		name: 'explain',
		description: 'Return the query plan for a read-only statement (runs EXPLAIN). Use before a large scan to check it before running it.',
		inputSchema: { type: 'object', properties: { ...CONNECTION_PROP, sql: { type: 'string', description: 'One read-only SQL statement to explain.' } }, required: ['connection', 'sql'] },
		annotations: READ_ONLY,
	},
];

/**
 * The agent's live view of its own permissions. Served only when this build has a capability
 * bridge, since otherwise there are no app actions for it to describe.
 */
const APP_ACTIONS_TOOL: ToolDef = {
	name: 'list_app_actions',
	description: "List everything this agent can do TO THE APP itself (open a tab, change a setting, build a monitor) and say, for each, whether it currently has the user's permission. Read-only. Anything that changes the app needs their say-so: calling such a tool asks them, in the app, and they can allow it once or for good. If app changes are switched off altogether, calling one asks them to turn that on. So \"needs permission\" means \"you have to ask\", never \"the app cannot do this\": offer the action, do not talk the user out of it. Call this rather than trusting the tool list, which is fixed when you connect and does not follow the user changing their mind.",
	inputSchema: { type: 'object', properties: {} },
	annotations: READ_ONLY,
};

interface ToolOutput {
	text: string;
	isError?: boolean;
	/** The connection the call resolved to, carried out for the audit record. */
	connectionId?: string;
	/** The statement that actually ran, when there was one, so the log can show and reopen it. */
	sql?: string;
	/** Rows the statement returned, for the log line. */
	rowCount?: number;
	/** True when the app REFUSED the call (policy), as opposed to the call failing. A refusal is
	 *  one of the more interesting things in an agent log, so it is recorded, and marked. */
	refused?: boolean;
}

/** A JSON-RPC error thrown from message handling, carrying a JSON-RPC error code. */
class RpcError extends Error {
	constructor(public readonly code: number, message: string) {
		super(message);
	}
}

export class LocalMcpServer {
	private server: Server | undefined;
	private boundPort = 0;
	/**
	 * The capability list as this client was told it. Snapshotted at `initialize` and then held
	 * still, because the transport is Streamable-HTTP with JSON responses and no SSE stream: there
	 * is no way to deliver `notifications/tools/list_changed`, so a tool list that changed under a
	 * client mid-session would just be a list it can never learn about. A capability registered
	 * later is picked up on the next connect.
	 */
	private capabilitySnapshot: CapabilitySpec[] | null = null;
	/** The agent's self-reported name from `initialize`, recorded on each audit entry so the log
	 *  says WHICH agent acted. Clients are not required to send one, hence the fallback. */
	private clientName = 'unknown agent';
	/** Monotonic per-process counter behind each audit record's callId. The JSON-RPC id is the
	 *  client's and can repeat across sessions, so it is not a stable key on its own. */
	private callSeq = 0;

	/** When each recent wrong bearer arrived, per remote address, inside the window. */
	private badBearers = new Map<string, number[]>();
	/** Remote addresses whose WRONG bearers are refused until the time each maps to. */
	private lockedOut = new Map<string, McpLockout>();

	constructor(private readonly deps: McpServerDeps) {}

	private now(): number {
		return this.deps.clock ? this.deps.clock() : Date.now();
	}

	running(): boolean {
		return this.server !== undefined;
	}

	port(): number {
		return this.boundPort;
	}

	/**
	 * Bind on 127.0.0.1 at exactly `port` (0: one the OS picks, for tests). Returns the bound port.
	 *
	 * Never walks to another port. The clients the person configured keep dialling this one with
	 * the token, so moving silently would leave them sending it to whatever took the port (which
	 * may have taken it for exactly that reason). A taken port throws {@link McpPortInUseError} and
	 * the app asks the person instead.
	 */
	async start(port: number): Promise<number> {
		if (this.server) {
			return this.boundPort;
		}
		try {
			return await this.listen(port);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' || (err as NodeJS.ErrnoException).code === 'EACCES') {
				throw new McpPortInUseError(port);
			}
			throw err;
		}
	}

	/** The remote addresses whose wrong bearers are refused right now, and until when. */
	lockouts(): McpLockout[] {
		const now = this.now();
		return [...this.lockedOut.values()].filter((l) => l.until > now);
	}

	/** Lift every lockout (the person replaced the token, so a guess at the old one is moot). */
	clearLockouts(): void {
		this.lockedOut.clear();
		this.badBearers.clear();
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	private listen(port: number): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => {
				void this.handle(req, res).catch((err) => {
					sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
				});
			});
			server.once('error', reject);
			server.listen(port, HOST, () => {
				server.removeListener('error', reject);
				this.server = server;
				// Read the actually-bound port from the socket (covers port 0 = OS-chosen).
				this.boundPort = (server.address() as AddressInfo).port;
				resolve(this.boundPort);
			});
		});
	}

	/** Validate auth + route, then dispatch JSON-RPC. Public so tests can drive it directly. */
	async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// DNS-rebinding guard, two halves (the bearer token is the real gate, this is defense in
		// depth). A rebound page reaches 127.0.0.1 under ITS OWN host name, so the Host header must
		// name this listener; and a browser sends an Origin where a CLI MCP client does not, so any
		// non-local Origin is refused outright.
		const remote = req.socket.remoteAddress ?? 'unknown';
		if (!mcpHostAllowed(req.headers.host, this.boundPort)) {
			sendJson(res, 403, { error: 'Forbidden host.' });
			return;
		}
		const origin = req.headers.origin;
		if (origin && !isLocalOrigin(origin)) {
			sendJson(res, 403, { error: 'Forbidden origin.' });
			return;
		}
		const [url, query = ''] = (req.url ?? '').split('?', 2);
		// The one route before auth: it is how a client checks this is the app BEFORE it sends the
		// token, so it cannot ask for the token, and it answers nothing but the proof.
		if (url === PROVE_ENDPOINT) {
			this.handleProve(req, res, query);
			return;
		}
		// Auth before routing, so an unauthenticated caller cannot even map what lives here. The right
		// token is served whatever else its address has sent; only a failing request is throttled.
		if (!this.authorized(req)) {
			const left = this.throttledFor(remote);
			if (left > 0) {
				res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(Math.ceil(left / 1000)) });
				res.end(JSON.stringify({ error: 'Too many requests with a wrong token: wrong tokens are refused for a while.' }));
				return;
			}
			this.noteBadBearer(req, remote);
			res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
			res.end(JSON.stringify({ error: 'Unauthorized: a valid Bearer token is required.' }));
			return;
		}
		if (url === WHOAMI_ENDPOINT) {
			await this.handleWhoami(req, res);
			return;
		}
		if (url === TOKEN_ENDPOINT) {
			await this.handleMint(req, res);
			return;
		}
		if (url !== ENDPOINT) {
			sendJson(res, 404, { error: `No route ${req.method} ${url}` });
			return;
		}
		// We never push server-initiated messages, so there's no SSE stream to GET.
		if (req.method === 'GET') {
			res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
			res.end(JSON.stringify({ error: 'Method not allowed; POST JSON-RPC to this endpoint.' }));
			return;
		}
		if (req.method !== 'POST') {
			res.writeHead(405, { allow: 'POST' });
			res.end();
			return;
		}

		let body: unknown;
		try {
			body = await readJson(req);
		} catch {
			sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON body.' } });
			return;
		}

		// A JSON-RPC call may be a single message or a batch. Notifications (no id) yield no response.
		const messages = Array.isArray(body) ? body : [body];
		const responses: unknown[] = [];
		for (const message of messages) {
			const response = await this.processMessage(message);
			if (response) {
				responses.push(response);
			}
		}
		if (responses.length === 0) {
			res.writeHead(202);
			res.end();
			return;
		}
		sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
	}

	private authorized(req: IncomingMessage): boolean {
		const bearer = bearerOf(req);
		return bearer !== null ? safeEqual(bearer, this.deps.token()) : false;
	}

	/** How long, in ms, wrong bearers from `remote` are still refused outright (0: not throttled). */
	private throttledFor(remote: string): number {
		const locked = this.lockedOut.get(remote);
		if (!locked) {
			return 0;
		}
		const left = locked.until - this.now();
		if (left <= 0) {
			this.lockedOut.delete(remote);
			return 0;
		}
		return left;
	}

	/** `GET /cli/prove?nonce=…`: see {@link PROVE_ENDPOINT}. */
	private handleProve(req: IncomingMessage, res: ServerResponse, query: string): void {
		if (req.method !== 'GET') {
			res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
			res.end(JSON.stringify({ ok: false, error: 'GET this endpoint.' }));
			return;
		}
		const nonce = new URLSearchParams(query).get('nonce') ?? '';
		if (!NONCE.test(nonce)) {
			sendJson(res, 400, { ok: false, error: 'A nonce of 22 to 128 base64url characters is required.' });
			return;
		}
		sendJson(res, 200, { ok: true, proof: studioProof(this.deps.token(), this.boundPort, nonce) });
	}

	/**
	 * Count a wrong bearer from `remote`, and throttle that address's wrong bearers once {@link BAD_BEARER_LIMIT}
	 * arrive inside the window. No header at all is a client that has not been configured, not a
	 * wrong token, and a retired token is a stale config: neither counts.
	 */
	private noteBadBearer(req: IncomingMessage, remote: string): void {
		const bearer = bearerOf(req);
		if (bearer === null) {
			return;
		}
		try {
			if (this.deps.isRetiredToken?.(bearer)) {
				return;
			}
		} catch {
			// Unknown is counted: a lookup that fails must not turn the lockout off.
		}
		const now = this.now();
		const recent = [...(this.badBearers.get(remote) ?? []).filter((at) => now - at < BAD_BEARER_WINDOW_MS), now];
		if (recent.length < BAD_BEARER_LIMIT) {
			this.badBearers.set(remote, recent);
			return;
		}
		this.badBearers.delete(remote);
		const lockout: McpLockout = { remote, until: now + LOCKOUT_MS, attempts: recent.length };
		this.lockedOut.set(remote, lockout);
		try {
			this.deps.onLockout?.(lockout);
		} catch (err) {
			console.error(`[mcp] could not report a lockout: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** The account this computer is signed in as, for the whoami answer and the mint's refusals. */
	private signedInEmail(): string | null {
		try {
			return this.deps.account?.() ?? null;
		} catch {
			return null;
		}
	}

	private handoffOn(): boolean {
		return this.deps.signInHandoff ? this.deps.signInHandoff() === true : true;
	}

	/**
	 * `GET /cli/whoami` — is somebody signed in to this app, and who.
	 *
	 * Answers whether or not any connection is on the MCP allowlist, because it is about the
	 * ACCOUNT and not about a database. Signed out is an ANSWER (`ok: true, signedIn: false`), not
	 * a failure: a caller branching on it should read a field, not an exception.
	 *
	 * It reports the EMAIL and nothing else that identifies the session. There is no shape of this
	 * route that returns a token, and adding one would undo "mint, never lend" by another name.
	 */
	private async handleWhoami(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
			res.end(JSON.stringify({ ok: false, code: 'usage', error: 'GET this endpoint.' }));
			return;
		}
		const email = this.signedInEmail();
		const handoff = this.handoffOn();
		const body: CliWhoamiResponse = {
			ok: true,
			app: { name: this.deps.serverInfo.name, version: this.deps.serverInfo.version },
			machine: this.machineName(),
			signedIn: email !== null,
			email,
			signInHandoff: handoff,
			// The single field worth branching on: is it worth offering "use the app's account?".
			canMintToken: email !== null && handoff && this.deps.mintCliToken !== undefined,
		};
		sendJson(res, 200, body);
		await Promise.resolve();
	}

	private machineName(): string {
		try {
			return this.deps.machine?.() ?? '';
		} catch {
			return '';
		}
	}

	/**
	 * `POST /cli/token` — mint a credential of the caller's own.
	 *
	 * The two rules this route exists to keep:
	 *
	 *   * It MINTS. What comes back is a fresh `sdt_` that shows up in `snoutdata tokens list`,
	 *     can be revoked there, and lands on the cloud audit log as itself rather than as the
	 *     person. The app's own session is never returned, and no field here could carry one.
	 *   * It ASKS first, and the asking is MANNERS, NOT A BOUNDARY. Any process running as this
	 *     user can already decrypt the app's `safeStorage` (DPAPI/Keychain, user-scoped), so the
	 *     prompt prevents surprise, not attack. The sentence that stays true is "the app does not
	 *     hand over your session without asking"; never "nothing could take it".
	 *
	 * Every refusal is a RESULT, not a protocol error: `{ok: false, code, error}` with a code
	 * worth branching on, so a caller can tell "switched off, stop offering" from "they said no
	 * this time" from "the control plane is down".
	 */
	private async handleMint(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== 'POST') {
			res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
			res.end(JSON.stringify({ ok: false, code: 'usage', error: 'POST this endpoint.' }));
			return;
		}
		let body: CliTokenRequestBody;
		try {
			const raw = await readJson(req);
			body = (raw && typeof raw === 'object' ? raw : {}) as CliTokenRequestBody;
		} catch {
			this.refuse(res, 400, 'usage', 'The request body was not JSON.');
			return;
		}
		if (!this.handoffOn()) {
			this.refuse(res, 403, 'disabled', 'Using the SnoutData app account from this computer is switched off. The person here can turn it back on in SnoutData, Settings, Agent access.');
			return;
		}
		if (this.signedInEmail() === null) {
			this.refuse(res, 401, 'not-signed-in', 'Nobody is signed in to SnoutData on this computer.');
			return;
		}
		if (!this.deps.mintCliToken) {
			this.refuse(res, 503, 'not-ready', 'This build cannot mint an access token.');
			return;
		}
		// `client` and `command` are the caller's own claims about itself. They are shown on the
		// consent card as claims, never trusted as facts, and clipped so a long one cannot push the
		// rest of the card off screen.
		const outcome = await this.deps.mintCliToken({
			client: clip(body.client, 60) || 'A program on this computer',
			command: clip(body.command, 60) || undefined,
		});
		if (!outcome.ok) {
			this.refuse(res, statusForTokenError(outcome.code), outcome.code, outcome.error);
			return;
		}
		// The user-facing Agent log answers "what has been going on here", and a credential minted
		// for something else on this computer belongs in that answer.
		try {
			this.deps.log({
				tool: 'sign_in_handoff',
				client: clip(body.client, 60) || 'A program on this computer',
				kind: 'app',
				summary: `Minted the access token "${outcome.name}" for a program on this computer`,
				mutates: true,
				outcome: { ok: true, durationMs: 0 },
			});
		} catch {
			// An unwritable log must never fail the mint the user just approved.
		}
		sendJson(res, 200, outcome);
	}

	private refuse(res: ServerResponse, status: number, code: CliTokenErrorCode, error: string): void {
		sendJson(res, status, { ok: false, code, error });
	}

	private async processMessage(message: unknown): Promise<unknown> {
		if (!message || typeof message !== 'object') {
			return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request.' } };
		}
		const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
		const isNotification = id === undefined || id === null;
		try {
			if (typeof method !== 'string') {
				throw new RpcError(-32600, 'Invalid Request: missing method.');
			}
			const result = await this.dispatchMethod(method, (params ?? {}) as Record<string, unknown>);
			// Notifications (initialized, etc.) get no response.
			return isNotification ? null : { jsonrpc: '2.0', id, result };
		} catch (err) {
			if (isNotification) {
				return null;
			}
			const code = err instanceof RpcError ? err.code : -32603;
			return { jsonrpc: '2.0', id, error: { code, message: err instanceof Error ? err.message : String(err) } };
		}
	}

	private async dispatchMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case 'initialize': {
				const info = params.clientInfo as { name?: unknown } | undefined;
				if (info && typeof info.name === 'string' && info.name.trim()) {
					this.clientName = info.name.trim();
				}
				// Fix the tool list for this client's session (see capabilitySnapshot).
				this.capabilitySnapshot = this.deps.capabilities?.() ?? [];
				return {
					protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: false } },
					serverInfo: this.deps.serverInfo,
					// How to work with this app, handed over on the wire rather than on a command line.
					// `instructions` is the transport's own place for this, which is why it is used
					// here instead of a launch flag: it reaches EVERY client, including the two
					// whose MCP handoff is manual and which therefore never see a flag of ours, and
					// it cannot be mangled by a Windows .cmd shim re-parsing a multi-line argument.
					instructions: agentHouseRules({
						serverName: MCP_SERVER_NAME,
						canDraw: this.capabilitySnapshot.some((spec) => spec.name === 'show_in_app'),
					}),
				};
			}
			case 'notifications/initialized':
			case 'initialized':
				return {};
			case 'ping':
				return {};
			case 'tools/list':
				return { tools: [...TOOLS, ...this.appActionTools()] };
			case 'tools/call': {
				const name = String(params.name ?? '');
				const args = (params.arguments ?? {}) as Record<string, unknown>;
				const output = await this.callTool(name, args);
				return { content: [{ type: 'text', text: output.text }], isError: output.isError ?? false };
			}
			default:
				throw new RpcError(-32601, `Method not found: ${method}`);
		}
	}

	/** Resolve a connection handle (label or id) to an exposed connection, or an error string. */
	private resolve(handle: unknown): { ref?: McpConnectionRef; error?: string } {
		const all = this.deps.connections();
		const needle = String(handle ?? '').trim().toLowerCase();
		if (!needle) {
			return { error: 'Provide a "connection" (a connection label or id from list_connections).' };
		}
		const ref = all.find((c) => c.id.toLowerCase() === needle || c.label.toLowerCase() === needle);
		if (!ref) {
			const known = all.filter((c) => c.allowed).map((c) => c.label).join(', ') || '(none exposed)';
			return { error: `No connection matching "${String(handle)}". Connections available to agents: ${known}.` };
		}
		if (!ref.allowed) {
			return { error: `Connection "${ref.label}" is not exposed to agents. Enable it in SnoutData Studio → Settings → Agent access.` };
		}
		return { ref };
	}

	/** Run a tool and record it. This is the MCP counterpart of the engine's `runTool` audit call:
	 *  one point that every agent tool passes through, so a tool added later is logged without
	 *  anyone remembering to log it. */
	private async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
		const startedAt = this.now();
		const callId = `mcp-${++this.callSeq}`;
		let output: ToolOutput;
		try {
			output = await this.runTool(name, args);
		} catch (err) {
			output = { text: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
		// One measurement, two records: the timeline and the audit trail must agree about how long
		// the call took, and reading the clock twice makes them disagree by a tick.
		const durationMs = this.now() - startedAt;
		// EVERY call is recorded, database or app, successful or refused: this log is the user's
		// answer to "what has the agent been doing", and a timeline with the refusals missing would
		// be the least honest version of it.
		try {
			this.recordActivity(name, args, output, durationMs);
		} catch {
			// An unwritable log must never fail the agent's call.
		}
		if (this.deps.audit) {
			// Best-effort: an unwritable audit log must never fail the agent's call.
			try {
				this.deps.audit({
					callId,
					tool: name,
					origin: 'mcp',
					mutates: isMutating(name, args) || this.capabilityByName(name)?.mutates === true,
					arguments: args,
					ok: !output.isError,
					summary: summarise(name, args, output),
					error: output.isError ? output.text : undefined,
					durationMs,
					connectionId: output.connectionId,
				}, this.clientName);
			} catch {
				// swallow
			}
		}
		return output;
	}

	/**
	 * The published capabilities, as MCP tools. Named exactly as the capability is (the registry
	 * already refuses a name that collides with a built-in database tool), so an agent calls
	 * `open_query_tab` the same way the assistant does and there is one vocabulary, not two.
	 */
	/** The app half of the tool list: what the agent can do to the app, plus the tool that says
	 *  where each one stands. Empty in a build with no capability bridge. */
	private appActionTools(): ToolDef[] {
		if (!this.deps.invokeCapability) {
			return [];
		}
		return [APP_ACTIONS_TOOL, ...this.capabilityTools()];
	}

	private capabilityTools(): ToolDef[] {
		const specs = this.capabilitySnapshot ?? this.deps.capabilities?.() ?? [];
		return specs.map((spec) => ({
			name: spec.name,
			// Say which ones change things, and say it in a sentence that stays true. The tool list
			// is frozen at connect (see capabilitySnapshot) and clients call tools/list once, so
			// baking the CURRENT permission in here ships a fact with a shelf life: the user flips
			// the switch in Settings and the agent goes on believing whatever it was told at
			// connect. The live answer is list_app_actions, which is one call away at any moment.
			description: spec.mutates
				? `${spec.description} (Changes the app, so it needs the user's permission. Call it when the task calls for it: the app asks them, and they can allow it once or for good. list_app_actions says what is already allowed.)`
				: spec.description,
			inputSchema: (spec.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
			annotations: spec.mutates
				? { readOnlyHint: false, destructiveHint: /^(delete|remove|reset|rotate)_/.test(spec.name) }
				: READ_ONLY,
		}));
	}

	/**
	 * Every app action and where it currently stands, as the agent's live view of its own
	 * permissions. This exists because the tool list is frozen at connect: it is the one place an
	 * agent can learn that the user has since said yes (or taken it back), and the one place the
	 * whole surface is listed whether or not it is allowed.
	 *
	 * Listing the refused ones matters more than it looks. An agent told only what it may do reads
	 * that as what the app CAN do, and then tells the user the app has no monitors rather than
	 * that it needs a yes to build one. The user never learns the feature exists, because nobody
	 * opens a settings page to browse a list of things they have not heard of.
	 */
	private listAppActions(): ToolOutput {
		const specs = this.capabilitySnapshot ?? this.deps.capabilities?.() ?? [];
		if (specs.length === 0) {
			return { text: 'This build exposes no app actions.' };
		}
		const changesAllowed = this.deps.allowMutatingCapabilities?.() === true;
		const standing = new Set(this.deps.autoApprovedCapabilities?.() ?? []);
		const lines = specs.map((spec) => {
			if (!spec.mutates) {
				return `- ${spec.name}: allowed (reads only, never asks)`;
			}
			if (!changesAllowed) {
				return `- ${spec.name}: needs permission (app changes are off; calling it asks the user to turn them on)`;
			}
			return standing.has(spec.name)
				? `- ${spec.name}: allowed (the user allowed this one for good; it runs without asking)`
				: `- ${spec.name}: needs permission (calling it asks the user, once)`;
		});
		const header = changesAllowed
			? 'App changes by agents are ON. Actions that change something still ask the user unless they allowed that one for good.'
			: 'App changes by agents are currently OFF. Every action below still WORKS: calling one asks the user to turn app changes on and allow it. Ask when the task calls for it; do not tell the user the app cannot do these things.';
		return { text: `${header}\n\n${lines.join('\n')}` };
	}

	/** What the AI may see of one database (or, with no id, the default). */
	private levelFor(connectionId: string | undefined): DataAccessLevel {
		return effectiveDataAccess(this.deps.dataAccess?.(connectionId));
	}

	private capabilityByName(name: string): CapabilitySpec | undefined {
		const specs = this.capabilitySnapshot ?? this.deps.capabilities?.() ?? [];
		return specs.find((spec) => spec.name === name);
	}

	/**
	 * Run one app capability. Its refusals are plain sentences rather than protocol errors, because
	 * the agent's job after a refusal is to tell the user what to switch on.
	 *
	 * A capability is held to the same per-connection allowlist as the database tools, whichever
	 * way it reaches a connection (its spec says, see `implicitConnection` and `returnsData`):
	 *
	 * - one it NAMES must be exposed to agents, and is passed on by id so the app acts on the one
	 *   checked here;
	 * - one it acts on WITHOUT naming (the active tab's, the result grid's, the last error's, the
	 *   connections of the flow or project it names) is asked of the app before anything runs, must
	 *   be exposed too, and is pinned: the app refuses the call if the answer changed meanwhile;
	 * - what it hands back from a database goes out only when every connection it came from is
	 *   exposed, and then only as much as that connection's data-access level allows.
	 *
	 * Without this an agent could run anything on whatever tab is active (insert_sql, then
	 * run_current), or read rows back out of a driver's error with get_last_error.
	 */
	private async runCapability(spec: CapabilitySpec, args: Record<string, unknown>): Promise<ToolOutput> {
		if (!this.deps.invokeCapability) {
			return { text: 'This build cannot run app actions.', isError: true };
		}
		const scoped = this.scopeCapability(spec, args);
		if (!scoped.ok) {
			return { text: scoped.error, isError: true, refused: true };
		}
		const implicit = await this.implicitConnections(spec, scoped.args);
		if (!implicit.ok) {
			return { text: implicit.error, isError: true, refused: true, connectionId: implicit.connectionId };
		}
		const answered = await this.deps.invokeCapability(spec.name, scoped.args, this.clientName, implicit.expect);
		const acting = [...(scoped.connectionId ? [scoped.connectionId] : []), ...implicit.ids];
		const connectionId = acting[0] ?? answered.dataConnectionId;
		const withheld = this.withheldContent(spec, answered, acting);
		if (withheld) {
			return { text: withheld, isError: true, refused: true, connectionId };
		}
		// Values are checked on the way OUT, against the level of the connection they came from.
		// Content tied to a connection not exposed to agents, or to none at all (a log line the app
		// could not attribute), is held to schema only: it keeps its error class and drops its text.
		const result = gateValuesResult(spec.name, answered, (id) => (id && this.deps.connections().some((c) => c.id === id && c.allowed) ? this.levelFor(id) : 'schema'));
		if (!result.ok) {
			return { text: result.error ?? `"${spec.name}" did not run.`, isError: true, refused: result.refused === true, connectionId };
		}
		// The summary is the human sentence the capability wrote about itself; `data` is what a
		// read capability actually returned. Both matter to the model, so both go out.
		const data = result.data === undefined ? '' : `
${JSON.stringify(result.data, null, 2)}`;
		return { text: `${result.summary || 'Done.'}${data}`, connectionId };
	}

	/**
	 * The arguments a capability may run with: its connection argument resolved to a connection
	 * exposed to agents and replaced by that connection's id. A required one left out is passed on
	 * (the capability refuses a call without it), as is one the spec says touches no connection when
	 * absent; any other optional one left out would mean the app's selected connection, which this
	 * agent may not be allowed, so it is refused here.
	 */
	private scopeCapability(spec: CapabilitySpec, args: Record<string, unknown>): { ok: true; args: Record<string, unknown>; connectionId?: string } | { ok: false; error: string } {
		const arg = capabilityConnectionArg(spec);
		if (!arg) {
			return { ok: true, args };
		}
		const value = args[arg];
		if (value === undefined || value === null || value === '') {
			const required = (spec.parameters as { required?: unknown }).required;
			if ((Array.isArray(required) && required.includes(arg)) || spec.connectionWhenAbsent === 'none') {
				return { ok: true, args };
			}
			return { ok: false, error: `Name the connection with "${arg}" (a connection label or id from list_connections). Left out, "${spec.name}" would use the one selected in the app, which may not be one the user has exposed to agents.` };
		}
		if (typeof value !== 'string') {
			return { ok: false, error: `"${arg}" must be a connection label or id from list_connections.` };
		}
		const resolved = this.resolve(value);
		if (resolved.error || !resolved.ref) {
			return { ok: false, error: resolved.error ?? 'Unknown connection.' };
		}
		return { ok: true, args: { ...args, [arg]: resolved.ref.id }, connectionId: resolved.ref.id };
	}

	/**
	 * The connections a capability acts on without the call naming them, asked of the app before it
	 * runs, each of which must be exposed to agents. `expect` pins them for the run.
	 */
	private async implicitConnections(spec: CapabilitySpec, args: Record<string, unknown>): Promise<{ ok: true; ids: string[]; expect?: string[] } | { ok: false; error: string; connectionId?: string }> {
		switch (spec.implicitConnection) {
			case 'none':
			case 'perItem':
				// perItem: each entry carries its own connection, judged on the way out.
				return { ok: true, ids: [] };
			case 'activeTab':
			case 'result':
			case 'lastError':
			case 'target':
				break;
			default: {
				// A kind added to the spec without a rule here is refused, never let through.
				const unknown: never = spec.implicitConnection;
				return { ok: false, error: `"${spec.name}" acts on a connection in a way this build cannot check (${String(unknown)}), so it is not run.` };
			}
		}
		const answer = this.deps.resolveCapabilityConnections
			? await this.deps.resolveCapabilityConnections(spec.name, args, this.clientName)
			: undefined;
		if (!answer || !answer.ok || !Array.isArray(answer.connectionIds)) {
			return { ok: false, error: `The app cannot say which connection "${spec.name}" would act on (${IMPLICIT_WHERE[spec.implicitConnection]}), so it is not run. ${answer?.error ?? ''}`.trim() };
		}
		for (const id of answer.connectionIds) {
			const ref = this.deps.connections().find((c) => c.id === id);
			if (!ref) {
				return { ok: false, error: `"${spec.name}" would act on a connection the app could not name (${IMPLICIT_WHERE[spec.implicitConnection]}), so it is not run.` };
			}
			if (!ref.allowed) {
				return {
					ok: false,
					connectionId: ref.id,
					error: spec.implicitConnection === 'lastError'
						? `The last error came from "${ref.label}", which is not exposed to agents, so it is not handed on. The user can enable it in SnoutData Studio → Settings → Agent access.`
						: `"${spec.name}" would act on "${ref.label}" (${IMPLICIT_WHERE[spec.implicitConnection]}), which is not exposed to agents. The user can enable it in SnoutData Studio → Settings → Agent access.`,
				};
			}
		}
		return { ok: true, ids: answer.connectionIds, expect: answer.connectionIds };
	}

	/**
	 * Why a capability's answer may not be handed on, or undefined. Anything it returns from a
	 * database (`returnsData`), its errors included, goes out only when every connection it came
	 * from is exposed to agents. Content the app could not tie to a connection goes out only when
	 * the engine knows how to reduce it to a value-free form (the last error, the log), which the
	 * data-access gate then does; otherwise it is withheld. The sentence is fixed: nothing of the
	 * withheld content is in it.
	 */
	private withheldContent(spec: CapabilitySpec, result: CapabilityResult, acting: string[]): string | undefined {
		if (spec.returnsData === 'none') {
			return undefined;
		}
		const exposed = (id: string): McpConnectionRef | string => {
			const ref = this.deps.connections().find((c) => c.id === id);
			if (!ref) {
				return `"${spec.name}" carries content from a database the app could not name, so it is not handed on.`;
			}
			return ref.allowed ? ref : `"${spec.name}" would hand on content from "${ref.label}", which is not exposed to agents. The user can enable it in SnoutData Studio → Settings → Agent access.`;
		};
		const sources = [...new Set([...acting, ...(result.dataConnectionId ? [result.dataConnectionId] : [])])];
		for (const id of sources) {
			const ref = exposed(id);
			if (typeof ref === 'string') {
				return ref;
			}
		}
		const carries = result.ok || result.errorFromDatabase === true;
		const reducible = valuesReducedBelowNeed(spec.name);
		const unattributed = `"${spec.name}" carries content from a database and the app could not say which, so it is not handed on.`;
		if (spec.implicitConnection === 'perItem') {
			// Each entry names its own connection. An entry from one not exposed, or from none, is
			// reduced by the gate where the engine knows how; anywhere else the whole answer is held.
			const entries = Array.isArray(result.data) ? result.data as { connectionId?: unknown }[] : undefined;
			if (carries && !entries) {
				return unattributed;
			}
			const unclear = (entries ?? []).some((entry) => typeof entry?.connectionId !== 'string' || typeof exposed(entry.connectionId) === 'string');
			return unclear && !reducible ? unattributed : undefined;
		}
		if (sources.length === 0 && carries && !reducible && ['none', 'result', 'lastError'].includes(spec.implicitConnection)) {
			return unattributed;
		}
		return undefined;
	}

	private async runTool(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
		if (name === 'list_connections') {
			const exposed = this.deps.connections().filter((c) => c.allowed);
			if (exposed.length === 0) {
				return { text: 'No connections are currently exposed to agents. The user can enable one in SnoutData → Settings → Agent access.' };
			}
			const lines = exposed.map((c) => {
				const tags = [c.engine ?? c.driver, c.environment, c.readOnly ? 'read-only' : undefined, c.writes && !c.readOnly ? 'writes allowed' : undefined].filter(Boolean).join(', ');
				// What stops a write on a read there: the statement check always, and per engine what
				// the database itself refuses, so an agent is told no more than is true.
				return c.writes && !c.readOnly ? `- ${c.label} (${tags})` : `- ${c.label} (${tags})\n  Reads: ${c.readOnlyBy}`;
			});
			return { text: `${exposed.length} connection(s) available:\n${lines.join('\n')}` };
		}

		if (name === 'list_app_actions') {
			return this.listAppActions();
		}


		// An app capability, if the renderer published one under this name. Checked BEFORE the
		// connection is resolved: a capability is about the app, not a database, and most take no
		// connection at all.
		const capability = this.capabilityByName(name);
		if (capability) {
			return this.runCapability(capability, args);
		}

		const resolved = this.resolve(args.connection);
		if (resolved.error || !resolved.ref) {
			return { text: resolved.error ?? 'Unknown connection.', isError: true };
		}
		const ref = resolved.ref;
		// What the AI may see of THIS database, checked before anything connects or runs.
		const refusal = dataAccessRefusal(name, this.levelFor(ref.id));
		if (refusal) {
			return { text: refusal, isError: true, refused: true, connectionId: ref.id };
		}
		// Tag every outcome with the connection it resolved to, so the audit record says which
		// database the agent touched without each branch having to remember to say so.
		return { ...(await this.dispatchConnectionTool(name, args, ref)), connectionId: ref.id };
	}

	private async dispatchConnectionTool(name: string, args: Record<string, unknown>, ref: McpConnectionRef): Promise<ToolOutput> {
		switch (name) {
			case 'list_tables':
			case 'describe_table':
			case 'search_columns': {
				const schema = await this.deps.resolveSchema(ref.id);
				if (!schema) {
					return { text: `Could not read the schema for "${ref.label}" (it may have failed to connect).`, isError: true };
				}
				return this.schemaTool(name, args, schema);
			}
			case 'run_query':
				return this.runQuery(ref, args);
			case 'explain':
				return this.explain(ref, args);
			default:
				return { text: `Unknown tool "${name}". Available tools: ${[...TOOLS, ...this.capabilityTools()].map((t) => t.name).join(', ')}.`, isError: true };
		}
	}

	private schemaTool(name: string, args: Record<string, unknown>, schema: DatabaseSchema): ToolOutput {
		const tables = schema.tables;
		if (name === 'list_tables') {
			const filter = String(args.filter ?? '').toLowerCase();
			const matched = filter ? tables.filter((t) => t.name.toLowerCase().includes(filter)) : tables;
			if (matched.length === 0) {
				return { text: filter ? `No tables match "${String(args.filter)}".` : 'The database has no tables.' };
			}
			const lines = matched.slice(0, MAX_TABLE_LINES).map((t) => `${qualified(t)} (${t.kind}, ${t.columns.length} cols)`);
			const more = matched.length > MAX_TABLE_LINES ? `\n…and ${matched.length - MAX_TABLE_LINES} more — narrow with a filter.` : '';
			return { text: `${matched.length} tables:\n${lines.join('\n')}${more}` };
		}
		if (name === 'describe_table') {
			const wanted = String(args.table ?? '').toLowerCase();
			if (!wanted) {
				return { text: 'Provide a table name.', isError: true };
			}
			const table = tables.find((t) => t.name.toLowerCase() === wanted || qualified(t).toLowerCase() === wanted);
			if (!table) {
				const near = tables.filter((t) => t.name.toLowerCase().includes(wanted)).slice(0, 10).map((t) => t.name);
				return { text: `No table named "${String(args.table)}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ' Use list_tables to see what exists.'}`, isError: true };
			}
			return { text: describeTable(table, schema.routines ?? []) };
		}
		// search_columns
		const term = String(args.term ?? '').toLowerCase();
		if (!term) {
			return { text: 'Provide a search term.', isError: true };
		}
		const hits: string[] = [];
		for (const table of tables) {
			if (table.name.toLowerCase().includes(term)) {
				hits.push(`${qualified(table)} (table)`);
			}
			for (const column of table.columns) {
				if (column.name.toLowerCase().includes(term)) {
					hits.push(`${qualified(table)}.${column.name} (${column.dataType})`);
				}
			}
			if (hits.length >= MAX_COLUMN_HITS) {
				break;
			}
		}
		return { text: hits.length ? `${hits.length} matches for "${String(args.term)}":\n${hits.join('\n')}` : `No tables or columns match "${String(args.term)}".` };
	}

	private async runQuery(ref: McpConnectionRef, args: Record<string, unknown>): Promise<ToolOutput> {
		const sql = String(args.sql ?? '').trim();
		if (!sql) {
			return { text: 'Provide a SQL statement.', isError: true };
		}
		// Read-only by default. A connection only escapes the guard when the user has explicitly
		// granted writes for it (ref.writes); even then the connection's own read-only flag, enforced
		// downstream in execute(), still has the final say.
		if (!ref.writes) {
			const refusal = readOnlyError(sql, ref.driver, ref.flavor);
			if (refusal) {
				return { text: refusal, isError: true, refused: true, sql };
			}
		}
		const maxRows = clampRows(args.maxRows);
		// A read (no write grant) also asks the DATABASE to refuse writes, where the engine can: the
		// check above is lexical and cannot see that `SELECT cleanup()` calls a function that writes.
		const outcome = await this.deps.execute(ref.id, autoLimit(sql, maxRows), { readOnly: !ref.writes });
		if (!outcome.ok) {
			return { text: `Query error: ${outcome.error}`, isError: true, sql };
		}
		const { fields, rows, rowCount, durationMs } = outcome.result;
		return { text: formatRows(fields.map((f) => f.name), rows, rowCount, durationMs, maxRows), sql, rowCount };
	}

	/** Write one line of the agent's activity timeline. Best-effort; never blocks the response. */
	private recordActivity(name: string, args: Record<string, unknown>, output: ToolOutput, durationMs: number): void {
		const ref = output.connectionId ? this.deps.connections().find((c) => c.id === output.connectionId) : undefined;
		this.deps.log({
			tool: name,
			client: this.clientName,
			kind: this.capabilityByName(name) ? 'app' : 'query',
			// The tool's own first line. NOT summarise(), which prefixes the tool name for the audit
			// log; the timeline already shows the tool as a chip, so that would read twice.
			summary: output.text.split('\n', 1)[0].trim(),
			mutates: isMutating(name, args) || this.capabilityByName(name)?.mutates === true,
			connectionId: ref?.id,
			connectionLabel: ref?.label,
			environment: ref?.environment,
			sql: output.sql,
			outcome: output.isError
				? { ok: false, error: output.text, refused: output.refused }
				: { ok: true, rowCount: output.rowCount, durationMs },
		});
	}

	private async explain(ref: McpConnectionRef, args: Record<string, unknown>): Promise<ToolOutput> {
		const sql = String(args.sql ?? '').trim().replace(/;\s*$/, '');
		if (!sql) {
			return { text: 'Provide a SQL statement to explain.', isError: true };
		}
		// The inner statement must itself be read-only.
		const refusal = readOnlyError(sql, ref.driver, ref.flavor);
		if (refusal) {
			return { text: refusal, isError: true };
		}
		const explained = `EXPLAIN ${sql}`;
		const outcome = await this.deps.execute(ref.id, explained, { readOnly: true });
		if (!outcome.ok) {
			return { text: `Explain error: ${outcome.error}`, isError: true, sql: explained };
		}
		const { fields, rows, rowCount, durationMs } = outcome.result;
		return { text: formatRows(fields.map((f) => f.name), rows, rowCount, durationMs, DEFAULT_MAX_ROWS), sql: explained, rowCount };
	}
}

/**
 * Did this call intend to change something? Only `run_query` can: every other agent tool reads.
 * Judged from the SQL rather than the outcome, exactly as the chat path judges it — "mutates" is
 * about what was attempted, so a write that errored at the database still reads as a write. A
 * statement that isn't read-only only reaches the driver on a connection the user granted writes
 * to, so this is also the flag that says "the write grant was used".
 */
function isMutating(name: string, args: Record<string, unknown>): boolean {
	return name === 'run_query' && typeof args.sql === 'string' && readOnlyError(args.sql) !== undefined;
}

/** One line describing the outcome, for the audit record. The tool's own first line of output is
 *  the most informative thing available ("3 tables:", "Refused: …"), so use it rather than
 *  re-deriving a description the tool already wrote. */
function summarise(name: string, args: Record<string, unknown>, output: ToolOutput): string {
	const first = output.text.split('\n', 1)[0].trim();
	const target = typeof args.connection === 'string' && args.connection ? ` on ${args.connection}` : '';
	return `${name}${target}: ${first.length > 200 ? `${first.slice(0, 200)}…` : first}`;
}

/** Trim a caller's claim about itself to something a card can show. */
function clip(value: unknown, max: number): string {
	const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
	return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

/**
 * The HTTP status for a mint refusal. The CODE is the contract and the status is a coarse index of
 * it, so a caller that only reads the status still branches roughly right.
 */
function statusForTokenError(code: CliTokenErrorCode): number {
	switch (code) {
		case 'usage':
			return 400;
		case 'not-signed-in':
			return 401;
		case 'disabled':
		case 'declined':
			return 403;
		case 'timeout':
			return 408;
		case 'not-ready':
			return 503;
		case 'forbidden':
			return 403;
		case 'network':
			return 504;
		case 'server':
		default:
			return 502;
	}
}

function clampRows(value: unknown): number {
	const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_ROWS;
	return Math.max(1, Math.min(MAX_MAX_ROWS, n));
}

/**
 * Whether a request's Host header names this listener: `127.0.0.1:<port>` or `localhost:<port>`
 * (the server binds 127.0.0.1 only). A DNS-rebinding page arrives with its own name here.
 */
export function mcpHostAllowed(host: string | undefined, port: number): boolean {
	const value = (host ?? '').toLowerCase();
	return port > 0 && (value === `127.0.0.1:${port}` || value === `localhost:${port}`);
}

function isLocalOrigin(origin: string): boolean {
	try {
		const host = new URL(origin).hostname;
		return host === '127.0.0.1' || host === 'localhost' || host === '::1';
	} catch {
		return false;
	}
}

/** The bearer a request carries, or null when it carries none. */
function bearerOf(req: IncomingMessage): string | null {
	const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
	return match ? match[1] : null;
}

/**
 * Constant time in the CONTENT of both strings and in their lengths: each is reduced to a fixed-size
 * HMAC under a per-process key first, so neither an early length check nor a byte-by-byte compare
 * says how close a guess was.
 */
function safeEqual(a: string, b: string): boolean {
	const ah = createHmac('sha256', COMPARE_KEY).update(a).digest();
	const bh = createHmac('sha256', COMPARE_KEY).update(b).digest();
	return timingSafeEqual(ah, bh);
}

const COMPARE_KEY = randomBytes(32);

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let raw = '';
		req.on('data', (chunk: Buffer) => {
			raw += chunk;
			if (raw.length > MAX_BODY) {
				reject(new Error('Request body too large.'));
				req.destroy();
			}
		});
		req.on('end', () => {
			try {
				resolve(raw ? JSON.parse(raw) : {});
			} catch {
				reject(new Error('Invalid JSON body.'));
			}
		});
		req.on('error', reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}
