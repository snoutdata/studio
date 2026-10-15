/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Snout Containers, as a cloud project's tab sees them: the customer's own image, running for as
// long as the project does, at `https://<ref>.api.snoutdata.com/containers/v1/<name>/`.
//
// The shapes `cloud-project-containers` answers in (the endpoint the dashboard and the CLI call),
// plus the little the tab decides for itself: which states are still moving, how a container is
// redeployed, and a name check so a build is not run for a name the control plane will refuse.
// Every rule that matters (the plan, the platform, the size) is the control plane's, and its
// refusal is shown in its own words.

/** What a container is doing, as its host last said. */
export type ContainerStatus = 'pending' | 'pulling' | 'starting' | 'running' | 'restarting' | 'failed' | 'stopped';

/** States still on their way somewhere: the list is re-read while one is showing. */
export const MOVING_STATUSES: readonly ContainerStatus[] = ['pending', 'pulling', 'starting', 'restarting'];

/** The image a container built from a folder is listed as, in place of its reference. */
export const BUILT_IMAGE = 'built from a Dockerfile';

/** The port a container is told to listen on when a deploy names none. */
export const DEFAULT_CONTAINER_PORT = 8080;

export interface CloudContainer {
	name: string;
	/** The image reference, or BUILT_IMAGE for one built from a folder. */
	image: string;
	/** Built from a folder: redeployed by its digest, never by a reference. */
	built: boolean;
	digest: string;
	port: number;
	url: string;
	privateRegistry: boolean;
	status: ContainerStatus;
	statusDetail: string | null;
	restarts: number;
	statusAt: string | null;
	/** False when the plan no longer covers it: it is kept, and stopped. */
	allowed: boolean;
	updatedAt: string | null;
}

export interface CloudContainerAllowance {
	deployed: number;
	maxContainers: number;
	memoryMb: number;
	cpuPercent: number;
	/** This month's sending (UTC); at the allowance the project's containers stop until the 1st. */
	egress: { month: string | null; usedBytes: number; allowanceBytes: number; held: boolean } | null;
}

export interface CloudContainers {
	allowance: CloudContainerAllowance | null;
	containers: CloudContainer[];
}

export interface CloudContainerLogLine {
	name: string;
	stream: 'stdout' | 'stderr';
	message: string;
	at: string;
}

/** What "Deploy from a folder" sends to main: the folder must be one main's picker handed out. */
export interface ContainerBuildForm {
	name: string;
	folder: string;
	port?: number;
}

/** One line of a folder build's progress, keyed by the build it belongs to. */
export interface ContainerBuildProgress {
	buildId: string;
	line: string;
}

/**
 * A sentence from SnoutData Cloud with anything of the infrastructure behind it taken out: a
 * registry host (with the path after it), a provider resource name, and any bare 12-digit account
 * number. The cloud already answers without them; this is the second line, so a sentence that
 * slips through is never shown as it came.
 */
export function withoutCloudInternals(text: string): string {
	return text
		.replace(/\b\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\/[^\s"',;)]*)?/g, "SnoutData's registry")
		.replace(/\barn:aws[a-z-]*:[^\s"',;)]*/g, 'a SnoutData credential')
		.replace(/\b[a-z0-9.-]*\.amazonaws\.com(?:\/[^\s"',;)]*)?/g, 'SnoutData Cloud')
		.replace(/\b\d{12}\b/g, '(an account)');
}

/** Lower case, so the name is the same in a URL, a container name and a unit name. */
const CONTAINER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Why a name would be refused, or null. The control plane checks again; this saves a build. */
export function containerNameProblem(name: string): string | null {
	if (CONTAINER_NAME.test(name)) {
		return null;
	}
	return `"${name}" is not a container name: lower-case letters, digits, hyphens and underscores, up to 32 characters, starting with a letter or a digit.`;
}

/** A port typed into a form: undefined for empty (the default), NaN-free, or a sentence. */
export function parsePort(text: string): { port?: number; problem?: string } {
	const trimmed = text.trim();
	if (!trimmed) {
		return {};
	}
	const port = Number(trimmed);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { problem: `${trimmed} is not a port: 1 to 65535.` };
	}
	return { port };
}

export function isMoving(containers: readonly CloudContainer[]): boolean {
	return containers.some((c) => MOVING_STATUSES.includes(c.status));
}

/** The first twelve hex characters of a digest, the way `docker images` shows one. */
export function shortDigest(digest: string): string {
	return digest.replace(/^sha256:/, '').slice(0, 12);
}

/**
 * The same container again. A built image goes back by its digest (its reference is the fleet's
 * and never reaches this screen); any other resolves its tag again, so a moved tag is picked up,
 * and a private one reuses the stored login.
 */
export function redeployArgs(container: CloudContainer): { name: string; port: number; pushed?: string; image?: string } {
	return container.built
		? { name: container.name, pushed: container.digest, port: container.port }
		: { name: container.name, image: container.image, port: container.port };
}

/** Bytes as GB with at most one decimal: 5 GB, 0.3 GB. */
export function gigabytes(bytes: number): string {
	return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
}
