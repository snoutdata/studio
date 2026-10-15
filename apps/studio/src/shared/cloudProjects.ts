/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CloudContainerLogLine, CloudContainers } from './cloudContainers';

// What the Cloud panel shows, and what came back when it asked for something.
//
// In `shared` because three processes need the same shape: main computes it
// (`main/cloudProjects.ts`), the preload carries it across, and the renderer draws it.
// The DECIDING stays in main — this file is types only and holds no logic, exactly like
// the other contracts here.
//
// Create, start, stop, delete, inspect: the same life the dashboard and the CLI give a
// project. Every one of them is the same Snout Function those two call, so quotas, regions,
// billing and every refusal stay the control plane's; the desktop only asks.

/**
 * Where a project can be put. A constant, like the dashboard's, because `cloud_hosts` has no
 * read policy for a signed-in client; the server answers `no-capacity` for a region it cannot
 * place in, and that sentence is what the form shows.
 */
export const CLOUD_REGIONS: ReadonlyArray<{ id: string; label: string }> = [
	{ id: 'us-west-2', label: 'us-west-2 (Oregon)' },
];

/** What the New Project form sends. */
export interface CloudCreateForm {
	name: string;
	region: string;
	production: boolean;
}

/** One project as the panel shows it: the facts, plus what may be done to it. */
export interface CloudProjectRow {
	ref: string;
	name: string;
	region: string;
	production: boolean;
	state: string;
	/** What it is being moved TOWARDS, when that differs from where it is. */
	desiredState?: string;
	/** True while the state and the desired state disagree: something is happening. */
	busy: boolean;
	readOnly: boolean;
	/** False when the data is in the bucket: the next connection is a restore, not a start. */
	wakesInstantly: boolean;
	sizeBytes: number | null;
	host: string;
	database: string;
	user: string;
	createdAt: string | null;
	lastConnectionAt: string | null;
	/** May the user stop this now, and if not, why not — in the control plane's own words. */
	canPause: boolean;
	pauseRefusal?: string;
	canResume: boolean;
	/** May the user delete this now. False only while something else is happening to it. */
	canDelete: boolean;
}

export interface CloudProjectsView {
	/** The signed-in account, or null. */
	account: string | null;
	projects: CloudProjectRow[];
	/** A sentence to show INSTEAD of the list: not signed in, offline, nothing there yet. */
	unavailable?: string;
}

/** What came back from asking a project to stop or start. */
export interface CloudActionOutcome {
	ok: boolean;
	/**
	 * The app stopped it, as opposed to it going wrong.
	 *
	 * A refusal is its own outcome (the same distinction `McpLogPanel` draws): "a
	 * production project is never paused" is the system working, and painting it the same
	 * red as "the control plane is unreachable" tells the user something broke when
	 * nothing did. Refusals read amber; failures read red.
	 */
	refused?: boolean;
	/** What to say: the control plane's refusal, or what was asked for. */
	message: string;
}

/** What came back from creating a project. */
export interface CloudCreateOutcome extends CloudActionOutcome {
	/** The new project's ref, when it was created. */
	ref?: string;
	/** A connection was added for it, so it is in the explorer already. */
	connected?: boolean;
}

// ---------------------------------------------------------------------------------------------
// The Cloud project tab: everything a project has beyond its lifecycle. Each operation is one
// Snout Function the dashboard or the CLI calls.

// The tab's sections are shared with local projects: shared/projects.ts.

export interface CloudUsageDay {
	day: string;
	dbBytes: number | null;
	repoBytes: number | null;
	computeSeconds: number;
	connections: number;
}

export interface CloudUsage {
	days: CloudUsageDay[];
	limit: { tier: string; maxStorageBytes: number } | null;
}

export interface CloudExport {
	pending: boolean;
	requestedAt?: string | null;
	completedAt?: string | null;
	bytes?: number | null;
	url: string | null;
	urlExpiresAt?: string | null;
	error: string | null;
}

export interface CloudRestoreWindow {
	available: boolean;
	pitrEnabled: boolean;
	tier: string;
	earliest: string | null;
	latest: string | null;
	retentionDays: number | null;
}

export interface CloudBackups {
	export: CloudExport | null;
	restore: CloudRestoreWindow | null;
}

export interface CloudConnectionFacts {
	host: string;
	port: number;
	database: string;
	user: string;
}

export interface CloudServices {
	auth: { enabled: boolean; googleEnabled: boolean; samlEnabled: boolean } | null;
	storage: { enabled: boolean; pending: boolean; bytes: number | null; files: number | null; lastError: string | null; maxFilesBytes: number | null } | null;
	dataApi: { enabled: boolean; allowed: boolean } | null;
	/** Snout Push: on or off, and whether this plan may schedule sends. */
	push: { enabled: boolean; scheduling: boolean } | null;
	/** Per service, why it could not be read, when it could not. */
	errors: Partial<Record<'auth' | 'storage' | 'dataApi' | 'push', string>>;
}

export interface CloudFunctionRow {
	name: string;
	verifyJwt: boolean;
	bytes: number | null;
	updatedAt: string | null;
	/**
	 * Its size as it runs: the memory one worker may use, and how many workers it may run
	 * at once, clamped to the plan it is on now. Null from a control plane that does not size functions.
	 */
	memoryMb?: number | null;
	concurrency?: number | null;
}

/** The plan's numbers a function is sized within: memory × workers ≤ `podMemoryMb`. */
export interface CloudFunctionPlan {
	tier: string;
	functionMemoryMb: number;
	concurrencyMax: number;
	podMemoryMb: number;
}

export interface CloudSecretRow {
	name: string;
	bytes: number | null;
	updatedAt: string | null;
}

export interface CloudFunctions {
	functions: CloudFunctionRow[];
	secrets: CloudSecretRow[];
	/** Null from a control plane that does not size functions. */
	plan: CloudFunctionPlan | null;
}

export interface CloudDnsRecord {
	type: string;
	name: string;
	value: string;
}

export interface CloudDomain {
	hostname: string;
	verified: boolean;
	verificationError: string | null;
	record: CloudDnsRecord | null;
	certificateRecord: CloudDnsRecord | null;
	certificate: { state: string | null; expiresAt: string | null; error: string | null } | null;
}

/** What may go on the clipboard. Each is fetched in main and written there, never sent here. */
export type CloudCopyTarget = 'uri' | 'password' | 'appKey' | 'serverKey';

/** Every operation the tab can ask for: its arguments and what it answers with. */
export interface CloudProjectOps {
	usage: { args: { ref: string }; result: CloudUsage };
	connection: { args: { ref: string }; result: CloudConnectionFacts };
	copy: { args: { ref: string; what: CloudCopyTarget }; result: { copied: CloudCopyTarget } };
	resetPassword: { args: { ref: string }; result: { appliesIn: string; updatedConnections: number } };
	rotateKeys: { args: { ref: string }; result: { breaks: string } };
	backups: { args: { ref: string }; result: CloudBackups };
	requestExport: { args: { ref: string }; result: CloudExport };
	restore: { args: { ref: string; at: string; name?: string }; result: { ref: string; name: string } };
	services: { args: { ref: string }; result: CloudServices };
	setService: { args: { ref: string; service: 'auth' | 'storage' | 'dataApi' | 'push'; enable: boolean }; result: { note: string | null } };
	functions: { args: { ref: string }; result: CloudFunctions };
	sizeFunction: { args: { ref: string; name: string; memoryMb?: number; concurrency?: number; reset?: boolean }; result: CloudFunctions };
	setSecret: { args: { ref: string; name: string; value: string }; result: CloudSecretRow[] };
	unsetSecret: { args: { ref: string; name: string }; result: CloudSecretRow[] };
	domains: { args: { ref: string }; result: CloudDomain[] };
	domain: { args: { ref: string; action: 'add' | 'verify' | 'remove'; hostname: string }; result: { domain: CloudDomain | null; next: string | null } };
	/**
	 * A sharded project's management (`cloud-project-shards`): status, plan, advice, jobs, and
	 * running an operation. Forwarded as it is; the answer is the router's own (or the control
	 * plane's, for a node pod), typed by the caller from shared/cloudShards.ts.
	 */
	shards: { args: { ref: string; action: string; [field: string]: unknown }; result: Record<string, unknown> };
	/** Snout Containers (`cloud-project-containers`), shapes in shared/cloudContainers.ts. */
	containers: { args: { ref: string }; result: CloudContainers };
	/**
	 * Deploy an image from a registry (`image`), or again by the digest a folder build pushed
	 * (`pushed`). A registry token typed by the user crosses once, here, and never comes back.
	 */
	deployContainer: {
		args: { ref: string; name: string; image?: string; pushed?: string; port?: number; registryUser?: string; registryPassword?: string; clearCredential?: boolean };
		result: CloudContainers;
	};
	restartContainer: { args: { ref: string; name: string }; result: CloudContainers };
	removeContainer: { args: { ref: string; name: string }; result: CloudContainers };
	/** Newest first, as the endpoint answers. */
	containerLogs: { args: { ref: string; name: string; errorsOnly?: boolean; limit?: number }; result: CloudContainerLogLine[] };
}

export type CloudProjectOp = keyof CloudProjectOps;

/** An operation's answer: the data, or the refusal or failure in the control plane's words. */
export type CloudProjectOutcome<T> = { ok: true; data: T } | { ok: false; refused: boolean; message: string };
