/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Local projects: the whole SnoutData stack (published as github.com/snoutdata/snout-stack)
// running in the user's own Docker, set up and run from the Projects panel.
//
// In `shared` because main computes it, the preload carries it and the renderer draws it. Types
// and constants only: the deciding is in `main/localStack/plan.ts`, which is pure and tested.

import type { Vocabulary } from './ownLayout';

/** One requirement the setup checks, and what to do about it when it is not met. */
export interface LocalRequirement {
	id: 'docker' | 'engine' | 'compose' | 'memory' | 'network';
	label: string;
	/** `ok`, `warn` (it will run, but say so) or `fail` (setup cannot go on). */
	status: 'ok' | 'warn' | 'fail';
	/** What was found, in a sentence. */
	detail: string;
	/** What to do about it, when there is something to do. */
	advice?: string;
	/** A page that helps (the installer, the docs). */
	link?: { label: string; url: string };
	/** The app can start the engine itself (Docker Desktop is installed and not running). */
	canStartEngine?: boolean;
}

export interface LocalRequirements {
	/** Every `fail` is cleared. */
	ready: boolean;
	items: LocalRequirement[];
	/** The engine's name as it reports itself ("Docker Desktop", "Podman", "Docker Engine"). */
	engine?: string;
}

/** What the setup wizard asks. Every field maps onto one or more `.env` values (plan.ts `envFor`). */
export interface LocalSetupForm {
	name: string;
	/** The folder the project lives in: compose.yaml, .env and functions/. */
	folder: string;
	apiPort: number;
	dbPort: number;
	/** Reachable from other machines on the network, or this one only. */
	exposeApi: boolean;
	/** Where the user's application runs: where a sign-in link lands. */
	siteUrl: string;
	/** Sign-ups are confirmed without a mail. Local default: on, since there is no mail server. */
	autoconfirm: boolean;
	disableSignup: boolean;
	smtp?: { host: string; port: number; user: string; pass: string; adminEmail: string; senderName: string };
	/** The bundled object store (`objects` profile). Off means files go to the user's own S3. */
	bundledStorage: boolean;
	/** Image resizing (`images` profile). */
	images: boolean;
	s3?: { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string };
	/** Add the project's database to Connections. */
	addConnection: boolean;
}

/** One step of an install or an upgrade, as it streams to the wizard. */
export interface LocalProgress {
	installId: string;
	step: 'download' | 'keys' | 'pull' | 'start' | 'connect' | 'done' | 'failed';
	/** A sentence for the step list. */
	message: string;
	/** A raw line of the engine's own output, for the log under the steps. */
	line?: string;
}

export interface LocalInstallOutcome {
	ok: boolean;
	message: string;
	id?: string;
}

/** One service of the stack, as `docker compose ps` reports it. */
export interface LocalService {
	name: string;
	/** running, exited, created, restarting, paused, dead, or `missing` when never created. */
	state: string;
	/** healthy, unhealthy, starting, or empty when the service has no health check. */
	health: string;
	/** The one-shots (`setup`, `functions-deploy`) are meant to exit 0. */
	oneShot: boolean;
	exitCode: number | null;
}

/** A local project as the panel lists it. */
export interface LocalProjectRow {
	id: string;
	name: string;
	folder: string;
	ref: string;
	apiUrl: string;
	dbPort: number;
	/** `running`, `stopped`, `partial` (some services down), `starting`, `missing` (folder gone) or `unknown` (engine not reachable). */
	state: 'running' | 'stopped' | 'partial' | 'starting' | 'missing' | 'unknown';
	services: LocalService[];
	createdAt: string;
	/** Marked production: its connection carries the production guard, and Stop asks first. */
	production: boolean;
	/** The names its gateway serves: those of the snout-stack its own compose.yaml runs. */
	vocabulary: Vocabulary;
}

export interface LocalProjectsView {
	projects: LocalProjectRow[];
	/** Why the states could not be read (the engine is not running), shown above the list. */
	unavailable?: string;
}

// The sections, and SQL and gateway calls, are shared with cloud projects: shared/projects.ts.

/** What the Connection & keys section shows. Nothing secret: those are copied, never sent. */
export interface LocalConnectionFacts {
	apiUrl: string;
	ref: string;
	host: string;
	port: number;
	database: string;
	user: string;
	folder: string;
	/** The paths the gateway serves, for the table under the URL. */
	paths: ReadonlyArray<{ path: string; what: string }>;
}

/** What may be copied: each goes to the clipboard in main, and never over IPC. */
export type LocalCopyTarget = 'apiUrl' | 'appKey' | 'serverKey' | 'dbUrl' | 'dbPassword';

/** The project's settings that can be changed after setup (a subset of the form, read from .env). */
export interface LocalSettings {
	siteUrl: string;
	apiPort: number;
	dbPort: number;
	exposeApi: boolean;
	autoconfirm: boolean;
	disableSignup: boolean;
	smtpHost: string;
	smtpPort: number;
	smtpUser: string;
	smtpAdminEmail: string;
	smtpSenderName: string;
	/** True when a password is set; the value itself never leaves main. */
	smtpPassSet: boolean;
	googleEnabled: boolean;
	googleClientId: string;
	githubEnabled: boolean;
	githubClientId: string;
	fileSizeLimitMb: number;
	/** Where clients reach the gateway (API_EXTERNAL_URL): localhost, or a public https address in front of it. */
	publicUrl: string;
	/** Behind a TLS proxy, the header it writes the caller's address into. Empty when there is none. */
	clientAddressHeader: string;
	/** Where a sign-in may return to besides the site URL, one address per entry (AUTH_URI_ALLOW_LIST). */
	redirectUrls: string[];
	/** Each function's memory, in MB (FUNCTIONS_MEMORY_MB). */
	functionsMemoryMb: number;
	/** How long one call may run, wall clock and CPU, in milliseconds. */
	functionsWallMs: number;
	functionsCpuMs: number;
	/** The memory every function shares: the functions container's limit, in MB. */
	functionsContainerMb: number;
	/** Functions callable with no API key (a webhook's receiver). */
	functionsNoVerify: string[];
}

/** A settings change. A secret field (`smtpPass`, `googleSecret`, `githubSecret`) is written only when given. */
export interface LocalSettingsChange extends Partial<Omit<LocalSettings, 'smtpPassSet'>> {
	smtpPass?: string;
	googleSecret?: string;
	githubSecret?: string;
}

export interface LocalFunctionRow {
	name: string;
	url: string;
}

/** The account emails auth sends, as the dashboard lists them. */
export type LocalMailKind = 'confirmation' | 'invite' | 'magic_link' | 'email_change' | 'recovery';

export interface LocalMailTemplate {
	kind: LocalMailKind;
	/** The project's own; otherwise auth's built-in one, shown so an edit starts from real text. */
	custom: boolean;
	subject: string;
	body: string;
}

/** An export in the project's backups folder: a `pg_dump` in the custom format. */
export interface LocalExport {
	name: string;
	bytes: number;
	at: string;
}

/** One thing the app did to a local project, for its Overview and Logs: the local activity log. */
export interface LocalActivity {
	at: string;
	what: string;
	ok: boolean;
}

export interface LocalActionOutcome {
	ok: boolean;
	message: string;
}
