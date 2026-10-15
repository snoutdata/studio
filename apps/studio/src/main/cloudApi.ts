/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the desktop asks SnoutData Cloud, as a seam.
//
// Split out of `cloudImport.ts` when the pods view became a second caller: the interface
// is "the control plane, as this app uses it", not "the import's dependency", and leaving
// it under the first feature that happened to need it is how a shared thing acquires a
// misleading name.
//
// Everything that DECIDES in the desktop's cloud features takes one of these and is pure,
// so a signed-out account, an empty one, an offline control plane and a refused action
// are provable in a millisecond. `cloudApiLive.ts` is the only implementation that
// reaches the control plane, and it is the only part that touches Electron. The rule is
// `shared/engine/host.ts`'s, applied here.
//
// Every call carries the user's own session, so RLS decides what comes back. There is no
// service key anywhere in the desktop and no path that reads a project "because the app
// asked".

/** A project as `cloud-project-list` describes it, of the parts the desktop uses. */
export interface CloudProjectSummary {
	ref: string;
	name: string;
	region: string;
	production: boolean;
	/** `creating` | `starting` | `ready` | `pausing` | `paused` | `restoring` | `error` | … */
	state: string;
	/** What the control plane has been ASKED for, which is not always what is true yet. */
	desiredState?: string;
	stateDetail?: string | null;
	host: string;
	database: string;
	user: string;
	/** False when the data is in the bucket rather than on a host: the next wake is a restore. */
	wakesInstantly: boolean;
	/** Over its plan's storage limit, so the database itself is refusing writes. */
	readOnly: boolean;
	sizeBytes?: number | null;
	createdAt?: string | null;
	lastConnectionAt?: string | null;
	pausedAt?: string | null;
}

/** What `cloud-project-connection` returns. The password is why it is a separate call. */
export interface CloudConnectionDetails {
	ref: string;
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	state: string;
}

/**
 * A freshly minted long-lived access token, as `cloud-token-create` returns it. The `token`
 * itself is sent ONCE, by that function, and never again: only its SHA-256 reaches the database.
 */
export interface CloudMintedToken {
	token: string;
	id: string;
	name: string;
	prefix: string;
	expiresAt: string | null;
}

/** What `cloud-project-export` says about a project's latest export, of the parts the desktop reads. */
export interface CloudExportStatus {
	pending: boolean;
	/** A download link while it is live (hours), null otherwise. */
	url: string | null;
	error: string | null;
}

/** What an action returns: the project as it now stands, and whether anything moved. */
export interface CloudActionResult {
	project: CloudProjectSummary;
	changed: boolean;
}

/** The Snout Functions the Cloud project tab reaches through `CloudApi.request`. */
export type CloudProjectFunction =
	| 'cloud-project-usage'
	| 'cloud-project-reset-password'
	| 'cloud-project-rotate-jwt'
	| 'cloud-project-export'
	| 'cloud-project-restore'
	| 'cloud-project-auth'
	| 'cloud-project-storage'
	| 'cloud-project-data-api'
	| 'cloud-project-push'
	| 'cloud-project-functions'
	| 'cloud-project-secrets'
	| 'cloud-project-domain'
	| 'cloud-project-sql'
	| 'cloud-project-shards'
	| 'cloud-project-containers';

/** How long the control plane gets before we tell the user we could not reach it. */
export const CLOUD_TIMEOUT_MS = 15_000;

/**
 * The functions that may WAIT on purpose before answering, each with its own allowance: the
 * server's bound plus the ordinary one, under the front door's 60-second ceiling. With 15 seconds
 * for everything, a key rotation (which waits up to 31.5 s for the host to remake the services), a
 * secret or a deploy (up to 15.5 s for the host to read it) and a section's SQL on a paused project
 * (a 40 s cold connect) came back as "did not answer in time" having done exactly what was asked.
 */
const WAITS: Readonly<Partial<Record<CloudProjectFunction, number>>> = {
	'cloud-project-functions': 45_000, // functionsLive.ts LIVE_WAIT_MS 15 s
	'cloud-project-secrets': 45_000, // the same wait
	'cloud-project-rotate-jwt': 50_000, // REFRESH_WAIT_MS 30 s + DOOR_GRACE_MS 1.5 s
	'cloud-project-sql': 58_000, // the function's own 55 s budget, a cold connect included
	'cloud-project-shards': 58_000, // ROUTER_MS 45 s
};

/** The allowance for one call, by the function's name (a GET's query string is not part of it). */
export function cloudTimeoutFor(name: string): number {
	const fn = name.split('?')[0] as CloudProjectFunction;
	return WAITS[fn] ?? CLOUD_TIMEOUT_MS;
}

export interface CloudApi {
	/** The signed-in account's email, or null when nobody is signed in. */
	account(): Promise<string | null>;
	list(): Promise<CloudProjectSummary[]>;
	connection(ref: string): Promise<CloudConnectionDetails>;
	/**
	 * Ask for a project to stop or start. These set a DESIRED state and return; the host
	 * agent notices on its next tick and does the work, so the answer is "asked", never
	 * "done". A screen that reported them as done would be lying for about five seconds.
	 *
	 * They can be refused, and the refusal is the control plane's sentence: a production
	 * project is never paused, a deleted one accepts nothing. Those rules live there and
	 * are not repeated here — a rule written twice is a rule that disagrees once.
	 */
	pause(ref: string): Promise<CloudActionResult>;
	resume(ref: string): Promise<CloudActionResult>;
	/**
	 * Mint a long-lived `sdt_` access token for the signed-in account.
	 *
	 * The desktop is allowed to do this and a CLI holding only a token is not, and the asymmetry
	 * is the point: `cloud-token-create` refuses to let a token mint a token, because a leaked
	 * token that can issue a fresh one cannot be revoked (the one you know about is not the one
	 * that is left). The app holds a real session, so it can. That is what makes the sign-in
	 * handoff MINT rather than lend.
	 *
	 * `expiresInDays` is left unset here: the credential exists so a CLI on this machine can work
	 * without a browser, and revoking it is `snoutdata tokens revoke`.
	 */
	mintToken(name: string): Promise<CloudMintedToken>;
	/**
	 * Create a project: the Cloud panel's New Project, and a move's target.
	 *
	 * Returns at once with the project `creating`; poll `list` for `ready`. The plan's project
	 * limit, the region and whether this tier may mark a project production are the control
	 * plane's to refuse.
	 */
	create(name: string, region: string, options?: { production?: boolean }): Promise<{ project: CloudProjectSummary }>;
	/** Ask for an export (asking twice is one export), and read how the latest is going, without asking. */
	requestExport(ref: string): Promise<CloudExportStatus>;
	exportStatus(ref: string): Promise<CloudExportStatus>;
	/** The control plane's soft delete, recoverable for the plan's grace period (the Cloud panel, and a Move that deletes its source). */
	remove(ref: string): Promise<CloudActionResult>;
	/**
	 * One of the Cloud project tab's calls (`cloudProjectOps.ts` gives each its shape). A GET
	 * carries `body` as its query string: reading a restore window must not be the verb that
	 * performs one.
	 */
	request<T>(fn: CloudProjectFunction, body: Record<string, unknown>, method?: 'POST' | 'GET'): Promise<T>;
}

/**
 * An error carrying the HTTP status, so a REFUSAL can be told from a FAILURE.
 *
 * 4xx is the control plane deciding — a production project that is never paused, a project
 * that is not yours. 5xx and a dead socket are something going wrong. The two deserve
 * different words and different colours, and without the status they are indistinguishable
 * by the time they reach a screen.
 */
export class CloudRequestError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = 'CloudRequestError';
	}

	/** The app stopped it, rather than it going wrong. */
	get refused(): boolean {
		return this.status >= 400 && this.status < 500;
	}
}

/** The message a Snout Function put in its body, which is always better than the status. */
export function detailFrom(error: unknown): string {
	if (error && typeof error === 'object' && 'message' in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === 'string' && message.trim() !== '') {
			return message;
		}
	}
	return String(error);
}
