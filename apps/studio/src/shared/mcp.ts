/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Contracts for the local MCP server: a credential broker that lets an external agent
// (Claude Code, or any MCP client) query the user's databases *through the app*, so DB
// credentials stay in the keychain and never land in a .env or repo.

/** One configured connection, plus whether it's exposed to agents over MCP. */
export interface McpConnectionInfo {
	id: string;
	label: string;
	driver: string;
	environment?: string;
	readOnly?: boolean;
	/** True when this connection is on the MCP allowlist (agents may reach it). */
	allowed: boolean;
	/** True when writes/DDL are permitted over MCP for this connection (off by default; only
	 *  meaningful for a connection that isn't itself read-only). */
	writes: boolean;
	/** What the DATABASE enforces when an agent's query runs read-only on this connection, as one
	 *  sentence (`readOnlyEnforcementFor(...).summary`), so the screen claims only what is true. */
	readOnlyBy: string;
}

/** The full state the Settings panel renders: the master switch, the live server, the
 *  connect snippet (url + bearer token), and the per-connection allowlist. */
export interface McpStatus {
	/** Master switch — when off, the server isn't listening regardless of the allowlist. */
	enabled: boolean;
	/** True while the HTTP server is actually bound and listening. */
	running: boolean;
	/** The MCP endpoint, e.g. http://127.0.0.1:7311/mcp. */
	url: string;
	/** The bearer token the client must send (shown so the user can paste the config). */
	token: string;
	/** The bound (or last-chosen) port. */
	port: number;
	connections: McpConnectionInfo[];
	/**
	 * Whether a program on this computer may ask to use the signed-in account (the sign-in
	 * handoff). On by default and inert until something asks: asking raises a prompt the user
	 * answers, and what they approve is a NEW revocable `sdt_` token, never the app's session. Off
	 * means the mint endpoint refuses outright.
	 */
	signInHandoff: boolean;
	/** What is wrong with agent access right now, if anything (see {@link McpProblem}). */
	problem: McpProblem | null;
}

/** A remote address whose wrong tokens the broker refuses for a while, after it sent too many (the right token still gets in). */
export interface McpLockout {
	/** The address the requests came from (on this computer, always a loopback one). */
	remote: string;
	/** Epoch ms when its wrong tokens stop being refused outright. */
	until: number;
	/** How many wrong tokens it sent inside the window. */
	attempts: number;
}

/**
 * What is wrong with agent access, for the notice and Settings → Agent access.
 * - `port-in-use`: the configured port was taken (by another program, perhaps waiting for the token),
 *   so the broker did not start. It never moves by itself; the person picks another port, which
 *   also replaces the token. `suggestedPort` is a free one above it, when one was found.
 * - `locked-out`: wrong tokens kept arriving, so further wrong tokens from that address are refused
 *   until `until`; the right token still gets in. The token was NOT replaced; the person may replace it.
 */
export type McpProblem =
	| { kind: 'port-in-use'; port: number; suggestedPort: number | null }
	| ({ kind: 'locked-out' } & McpLockout);

/** The notice for a problem: one title and one paragraph, the same in the notifications center and in Settings. */
export function mcpProblemNotice(problem: McpProblem): { title: string; detail: string } {
	if (problem.kind === 'port-in-use') {
		return {
			title: `Agent access is off: port ${problem.port} is in use`,
			detail: `Something else on this computer is listening on 127.0.0.1:${problem.port}, the port your agents are configured to reach, so the app did not start its agent server there and did not move to another port by itself. If you did not start that program, do not let an agent send it your token. In Settings, Agent access, you can move to ${problem.suggestedPort ? `port ${problem.suggestedPort}` : 'another port'}: that also replaces the token, and the coding agents this app starts get the new address. A config you pasted elsewhere needs the new one.`,
		};
	}
	const minutes = Math.max(1, Math.ceil((problem.until - Date.now()) / 60_000));
	return {
		title: "Agent access refused a program that kept sending a wrong token",
		detail: `${problem.attempts} requests with a wrong token arrived from ${problem.remote}, so the agent server refuses any further wrong token from that address for about ${minutes} minute${minutes === 1 ? '' : 's'}. Your own agents and anything else holding the right token still get in. The token was not changed. If you think it has leaked, replace it in Settings, Agent access.`,
	};
}

/**
 * One thing an agent did, in its own log (separate from the user's query history) and surfaced in
 * the Agent log panel.
 *
 * This started as "queries an agent ran" and is now the agent's whole ACTIVITY TIMELINE:
 * every tool call, database or app, including the ones that were REFUSED. It is deliberately an
 * OBSERVED record — what the app saw the agent do, not what the agent said about itself — so it
 * cannot be embellished. Hence sql/connection are optional: an app action has neither.
 */
export interface McpLogEntry {
	id: string;
	/** Epoch ms when the agent did it. */
	timestamp: number;
	/** The MCP tool called ('run_query', 'open_in_new_tab', ...). */
	tool: string;
	/** Which agent, as it named itself on connect (e.g. 'claude-code'). */
	client?: string;
	/** Whether this touched a database or the app itself, for filtering the timeline. */
	kind?: 'query' | 'app';
	/** One line describing what happened, for a row that has no SQL to show. */
	summary?: string;
	/** True when the call was one that CHANGES something (a write, or a mutating capability). */
	mutates?: boolean;
	connectionId?: string;
	connectionLabel?: string;
	environment?: string;
	/** The statement that ran, when there was one. Clicking such a row reopens it. */
	sql?: string;
	outcome:
		| { ok: true; rowCount?: number; durationMs: number }
		| { ok: false; error: string; refused?: boolean };
}

/** A log entry as the server emits it; the store stamps `id` + `timestamp`. */
export type McpLogInput = Omit<McpLogEntry, 'id' | 'timestamp'>;

/** The single-server config object (the value any MCP client stores under its server name).
 *  Shared so the Settings snippet and the agent console's generated config cannot drift. */
export function mcpServerConfig(status: Pick<McpStatus, 'url' | 'token'>): Record<string, unknown> {
	return { type: 'http', url: status.url, headers: { Authorization: `Bearer ${status.token}` } };
}

/** The name our server is registered under in every generated config. */
export const MCP_SERVER_NAME = 'snoutdata';

/** The standard `mcpServers` block any MCP client (Claude Code, Codex, Cline, ...) accepts. */
export function mcpConfigSnippet(status: Pick<McpStatus, 'url' | 'token'>): string {
	return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: mcpServerConfig(status) } }, null, 2);
}

/* ------------------------------------------------------------------------------------------------
 * The sign-in handoff: what the local server tells a program on this computer about the account,
 * and how that program gets a credential of its own.
 *
 * Built for `snoutdata` so the CLI can offer "you are signed in to the SnoutData app, use that?"
 * instead of sending a person to a browser at the wrong moment. Two plain HTTP routes on the server
 * that already exists, NOT MCP tools: the tool list is frozen at connect, and this is about the
 * account rather than about a database, so it must answer whether or not any connection is on the
 * allowlist.
 *
 * Two rules shape every line of it:
 *
 *   * **The app MINTS a token; it never lends its session**. Handing over the app's session
 *     gives away the whole login, with no way to see it or take it back. An `sdt_` shows up in
 *     `snoutdata tokens list`, is revocable, and lands on the audit log as itself. It is named for
 *     where it came from, which is what {@link cliTokenName} is for.
 *   * **The consent prompt is manners, not a boundary**. Any process running as this user can
 *     already decrypt the app's `safeStorage`: it is DPAPI/Keychain and user-scoped, which is
 *     equally true for the agent console. So the sentence that stays true is "the app does not hand
 *     over your session without asking", and never "nothing could take it". Any wording written for
 *     this feature says the first.
 * ---------------------------------------------------------------------------------------------- */

/** What `GET /cli/whoami` answers. Signed out is an ANSWER, not a failure, so `ok` stays true. */
export interface CliWhoamiResponse {
	ok: true;
	app: { name: string; version: string };
	/** This computer, as the minted token will be named after it. */
	machine: string;
	signedIn: boolean;
	/** The signed-in account's email, or null when nobody is signed in. */
	email: string | null;
	/** False when the user has switched the handoff off in Settings, Agent access. */
	signInHandoff: boolean;
	/** The one field to branch on: is it worth offering "use the app's account?" at all. */
	canMintToken: boolean;
}

/** Why `POST /cli/token` said no. A refusal is a result, not a protocol error. */
export type CliTokenErrorCode =
	/** Nobody is signed in to the app on this computer. */
	| 'not-signed-in'
	/** The user has switched the handoff off in Settings. Do not offer it again this run. */
	| 'disabled'
	/** The person at this computer said no. */
	| 'declined'
	/** Nobody answered the prompt in time. An unanswered question is not consent. */
	| 'timeout'
	/** There was no window to ask in, or this build has no control plane to mint through. */
	| 'not-ready'
	/** The control plane REFUSED (4xx). Retrying will not help; `error` carries its own sentence. */
	| 'forbidden'
	/** The control plane BROKE (5xx). Worth trying again. */
	| 'server'
	/** We could not reach the control plane at all. Worth trying again. */
	| 'network'
	/** The request itself was malformed. */
	| 'usage';

/** What `POST /cli/token` answers on success. The token is returned ONCE, here. */
export interface CliTokenSuccess {
	ok: true;
	/** The `sdt_…` access token. Never the app's session. */
	token: string;
	/** The name it carries in `snoutdata tokens list`, so a person can tell where it came from. */
	name: string;
	/** The token's non-secret prefix, as the control plane records it. */
	prefix: string;
	/** ISO timestamp, or null when it does not expire. */
	expiresAt: string | null;
}

export interface CliTokenFailure {
	ok: false;
	code: CliTokenErrorCode;
	/** The human sentence. The code is the contract; this is for people. */
	error: string;
}

export type CliTokenResponse = CliTokenSuccess | CliTokenFailure;

/** What a caller sends to `POST /cli/token`. Everything is optional: an unnamed caller still gets
 *  asked about, it is just described less well on the card. */
export interface CliTokenRequestBody {
	/** What is asking, as it names itself ("snoutdata-cli"). Shown on the consent card. */
	client?: string;
	/** The command it says it is running ("init"), so the card can say why. */
	command?: string;
}

/**
 * The name the minted token carries.
 *
 * Name the token so a person can tell where it came from. Someone scanning
 * `snoutdata tokens list` a month later has the machine and the fact that the app minted it, which
 * is enough to decide whether to revoke it. `cloud-token-create` caps a name at 80 characters.
 */
export function cliTokenName(machine: string): string {
	const where = machine.trim() || 'this computer';
	return `SnoutData CLI on ${where}`.slice(0, 80);
}

/** How long a sign-in handoff prompt stands before it is declined for the user. Shorter than an
 *  agent action's: somebody is watching a terminal wait on this one. */
export const CLI_SIGN_IN_TIMEOUT_MS = 45_000;

/**
 * A program on this computer is asking to use the signed-in account, and the user has to say yes.
 *
 * Deliberately carries the token's NAME, not just the request: the card shows the person exactly
 * what will appear in `snoutdata tokens list`, so "and I can take it back" is something they can
 * check rather than something we assert.
 */
export interface CliSignInRequest {
	requestId: string;
	/** What asked, as it named itself. Untrusted: it is shown as a quoted claim, never as a fact. */
	client: string;
	/** The command it said it was running, when it said one. */
	command?: string;
	/** This computer's name. */
	machine: string;
	/** The account a token would be minted for. */
	email: string;
	/** The name that token will carry. */
	tokenName: string;
	timeoutMs: number;
}

/** What the user answered on a {@link CliSignInRequest}. Not answering declines it. */
export type CliSignInAnswer = 'allow' | 'decline';
