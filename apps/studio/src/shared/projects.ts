/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A SnoutData project, local or in the cloud, as the desktop's project tab sees it.
//
// One menu and one set of sections serve both kinds, the way the cloud dashboard's sections serve
// every project: a section reaches its project through two doors, SQL as the owner and the
// project's gateway with the service key, and main decides where each door leads (a local
// project's own Postgres and gateway on this machine, or `cloud-project-sql` and
// `<ref>.api.snoutdata.com`). Types and constants only; the deciding is in main.

/** Which project: a local one by its id in userData/localProjects.json, a cloud one by its ref. */
export type ProjectTarget = { kind: 'local'; id: string } | { kind: 'cloud'; ref: string };

/** A stable key for a target: React keys, maps, comparisons. */
export function projectKey(target: ProjectTarget): string {
	return target.kind === 'local' ? `local:${target.id}` : `cloud:${target.ref}`;
}

/** What crossed IPC is a target, and nothing else. */
export function isProjectTarget(value: unknown): value is ProjectTarget {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as Record<string, unknown>;
	return (v.kind === 'local' && typeof v.id === 'string' && v.id.length > 0)
		|| (v.kind === 'cloud' && typeof v.ref === 'string' && /^[a-z][a-z0-9]{12}$/.test(v.ref));
}

/** The prefix of the window command that opens one project's tab (see openProjectCommand). */
const OPEN_PROJECT = 'openProject:';

/**
 * The command that opens a project's tab at Overview, for a caller that can only hand the window a
 * command id: the tray, which reaches the renderer through the same `menu:command` channel as the
 * app menu. The name rides along because it is the tab's title and the renderer has no list to
 * look it up in until the Dashboard panel has been opened.
 */
export function openProjectCommand(target: ProjectTarget, name: string): string {
	return `${OPEN_PROJECT}${JSON.stringify({ target, name })}`;
}

/** The target and name in an openProjectCommand, or null for any other command id. */
export function parseOpenProjectCommand(id: string): { target: ProjectTarget; name: string } | null {
	if (!id.startsWith(OPEN_PROJECT)) {
		return null;
	}
	try {
		const value = JSON.parse(id.slice(OPEN_PROJECT.length)) as { target?: unknown; name?: unknown };
		return isProjectTarget(value.target) && typeof value.name === 'string'
			? { target: value.target, name: value.name }
			: null;
	} catch {
		return null;
	}
}

/**
 * The sections a project has, in the order the tree and the tab show them: the cloud dashboard's
 * project menu, group for group and in its order, so a project reads the same in the dashboard,
 * in the app, local or cloud.
 */
export type ProjectSection =
	| 'overview' | 'database' | 'extensions' | 'cron' | 'timeSeries' | 'shards'
	| 'auth' | 'storage' | 'dataApi' | 'functions' | 'containers' | 'realtime' | 'push'
	| 'logs' | 'domains' | 'settings';

/** Inside Postgres; separate servers beside it, each with its own switch; the project as a whole. */
export type ProjectSectionGroup = 'database' | 'services' | 'manage';

export const PROJECT_SECTIONS: ReadonlyArray<{
	id: ProjectSection;
	label: string;
	icon: string;
	group: ProjectSectionGroup;
	/**
	 * Listed only for a cloud project the control plane OFFERS it to (shards: sharded, or a plan
	 * with room for a second node), so the tab asks first and the tree never lists it.
	 */
	gated?: 'shards';
}> = [
	{ id: 'overview', label: "Overview", icon: 'home', group: 'database' },
	{ id: 'database', label: "Database", icon: 'database', group: 'database' },
	{ id: 'extensions', label: "Extensions", icon: 'extensions', group: 'database' },
	{ id: 'cron', label: "Cron", icon: 'clock', group: 'database' },
	{ id: 'timeSeries', label: "Time series", icon: 'graph-line', group: 'database' },
	{ id: 'shards', label: "Cluster", icon: 'split-horizontal', group: 'database', gated: 'shards' },
	{ id: 'auth', label: "Auth", icon: 'shield', group: 'services' },
	{ id: 'storage', label: "Storage", icon: 'folder', group: 'services' },
	{ id: 'dataApi', label: "Data API", icon: 'json', group: 'services' },
	{ id: 'functions', label: "Functions", icon: 'code', group: 'services' },
	{ id: 'containers', label: "Containers", icon: 'package', group: 'services' },
	{ id: 'realtime', label: "Realtime", icon: 'pulse', group: 'services' },
	{ id: 'push', label: "Push", icon: 'bell', group: 'services' },
	{ id: 'logs', label: "Logs", icon: 'history', group: 'manage' },
	{ id: 'domains', label: "Domains", icon: 'globe', group: 'manage' },
	{ id: 'settings', label: "Settings", icon: 'settings-gear', group: 'manage' },
];

export const PROJECT_SECTION_GROUPS: ReadonlyArray<{ id: ProjectSectionGroup; label: string }> = [
	{ id: 'database', label: "Database" },
	{ id: 'services', label: "Services" },
	{ id: 'manage', label: "Manage" },
];

/** A section id from anywhere (a saved tab, an agent's argument), or Overview. */
export function projectSection(value: unknown): ProjectSection {
	return PROJECT_SECTIONS.some((s) => s.id === value) ? value as ProjectSection : 'overview';
}

/** A statement run as the project's owner. Rows are capped, and `truncated` says when they were. */
export interface ProjectSqlResult {
	ok: boolean;
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
	truncated: boolean;
	error?: string;
	/** The control plane stopped it (a production guard, a plan), as opposed to it failing. */
	refused?: boolean;
}

/** A call to the project's gateway with the server key, which main adds and never sends here. */
export interface ProjectApiRequest {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	/** Under /v1/identity/operator/, /v1/files/ or /v1/data/ only, in our names: main sends it in
	 *  the names the project's gateway serves (shared/ownLayout.ts). */
	path: string;
	body?: unknown;
}

export interface ProjectApiResponse {
	ok: boolean;
	status: number;
	body: unknown;
	/** The service's own sentence when it refused. */
	error?: string;
}

export interface ProjectActionOutcome {
	ok: boolean;
	message: string;
}
