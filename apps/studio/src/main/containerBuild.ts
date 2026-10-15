/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CloudRequestError, detailFrom, type CloudApi } from './cloudApi';
import { containerListing } from './cloudProjectOps';
import { containerNameProblem, withoutCloudInternals, type CloudContainers, type ContainerBuildForm } from '../shared/cloudContainers';
import type { CloudProjectOutcome } from '../shared/cloudProjects';

// "Deploy from a folder": a Snout Container built from a Dockerfile with the user's OWN Docker,
// the same steps as `snoutdata containers deploy <name> --dockerfile <dir>`. Nothing is built on
// our side: docker builds the folder for linux/arm64 into an image archive on this computer, the
// archive is uploaded to the project's own API address with a single-use link the control plane
// hands out (`upload-ticket`), and the deploy names the digest the upload was stored at
// (`pushed`). There is no registry login and no registry address anywhere in it: the link is the
// whole credential, and where the image is kept is SnoutData's business.
//
// Pure: docker, the files, the upload and the clock are a `ContainerBuildHost`, so the order of the
// steps and the sentence for each failure are tested without a Docker or a network.

/** A docker run's result, as the local stack's runner answers it. */
export interface DockerResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ContainerBuildHost {
	docker(args: string[], options?: { input?: string; onLine?(line: string): void }): Promise<DockerResult>;
	/** True when the folder holds a file called Dockerfile. */
	hasDockerfile(folder: string): boolean;
	/** A new private scratch folder, and the path of a file inside it. */
	scratch(): Promise<{ dir: string; file(name: string): string }>;
	/** How large a file is, in bytes. */
	fileSize(path: string): Promise<number>;
	/** PUT the file to the URL, streamed; `sent` is called as it goes. The answer's status and body. */
	upload(url: string, file: string, sent?: (bytes: number) => void): Promise<{ status: number; body: string }>;
	removeDir(dir: string): Promise<void>;
	now(): number;
}

interface UploadTicket {
	url: string;
	expiresAt: string;
}

/** The most an upload may be; the image itself may be at most 1 GB compressed, which the host checks. */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

/** A link is asked for again when less than this is left on it after the build. */
const TICKET_MARGIN_MS = 3 * 60_000;

/** `docker buildx build`'s arguments: linux/arm64 only, one image with no attestation, written to an OCI archive. */
export function buildArgs(input: { context: string; archive: string }): string[] {
	return [
		'buildx', 'build',
		'--platform', 'linux/arm64',
		// No provenance attestation: what is uploaded is one image, the one that runs.
		'--provenance=false',
		'--progress=plain',
		'--output', `type=oci,dest=${input.archive}`,
		input.context,
	];
}

/** Docker could not be asked anything: not installed, or installed and not running. */
export function dockerUnavailable(result: DockerResult): string {
	const said = `${result.stderr}\n${result.stdout}`;
	if (result.code === -1 && /not found|ENOENT/i.test(said)) {
		return "Deploy from a folder builds with your own Docker, and none was found on this computer. Install Docker Desktop, or deploy an image from a registry.";
	}
	return "Docker is installed but not running. Start Docker, then build again.";
}

/** The sentence for a build that failed, from what docker printed. */
export function buildFailure(output: string): string {
	if (/exec format error/i.test(output)) {
		return "A build step ran an arm64 program that this computer cannot run. Docker Desktop runs them by emulation. On Linux, set up emulation as Docker's multi-platform guide describes (docs.docker.com/build/building/multi-platform); its usual command runs a third-party image with root-level access, so read it before you run it.";
	}
	if (/no match for platform in manifest|does not provide the specified platform|no matching manifest for linux\/arm64/i.test(output)) {
		return "An image the Dockerfile builds FROM has no linux/arm64 version, and SnoutData Cloud runs arm64 only. Use a base image published for arm64 (most official images are).";
	}
	if (/exporter is not supported for the docker driver|not supported for the docker driver/i.test(output)) {
		return "This Docker's default builder cannot write an image archive. Turn on the containerd image store (Docker Desktop: Settings, General, \"Use containerd for pulling and storing images\"), or make a builder that can with: docker buildx create --use";
	}
	if (/Cannot connect to the Docker daemon|error during connect|daemon is not running/i.test(output)) {
		return "Docker stopped answering during the build. Start Docker, then build again.";
	}
	const last = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^ERROR\b|error:/i.test(l)).pop();
	return last ? `The build failed: ${last.replace(/^ERROR:?\s*/i, '')}` : "The build failed. Its output is above.";
}

/** The sentence an upload's refusal carries, or one for a status with none. */
export function uploadFailure(status: number, body: string): string {
	let said = '';
	try {
		const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
		said = String(parsed.error ?? parsed.message ?? '');
	} catch {
		// Not JSON: the status says it.
	}
	if (said) {
		return withoutCloudInternals(said);
	}
	if (status === 413) {
		return "The image is too large to upload. A container's image may be at most 1 GB compressed; a slimmer base (alpine, distroless, -slim) usually fixes it.";
	}
	return `The upload failed (${status}). Build again in a moment.`;
}

function megabytes(bytes: number): string {
	return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

async function uploadTicket(api: CloudApi, ref: string, name: string): Promise<UploadTicket> {
	const ticket = await api.request<Partial<UploadTicket>>('cloud-project-containers', { ref, action: 'upload-ticket', name });
	if (typeof ticket.url !== 'string' || !ticket.url.startsWith('https://')) {
		throw new CloudRequestError("SnoutData Cloud did not hand over an upload link. Try again in a moment.", 502);
	}
	return { url: ticket.url, expiresAt: String(ticket.expiresAt ?? '') };
}

/**
 * Build the folder, upload it, deploy it. `say` gets docker's output and a line per step; every
 * sentence from the cloud passes `withoutCloudInternals` before it is shown.
 */
export async function buildAndDeploy(
	api: CloudApi,
	host: ContainerBuildHost,
	ref: string,
	form: ContainerBuildForm,
	say: (line: string) => void,
): Promise<CloudProjectOutcome<CloudContainers>> {
	const name = form.name.trim();
	const badName = containerNameProblem(name);
	if (badName) {
		return { ok: false, refused: true, message: badName };
	}
	if (!host.hasDockerfile(form.folder)) {
		return { ok: false, refused: true, message: `${form.folder} has no Dockerfile in it.` };
	}
	const version = await host.docker(['version', '--format', '{{.Server.Version}}']);
	if (version.code !== 0) {
		return { ok: false, refused: true, message: dockerUnavailable(version) };
	}
	const buildx = await host.docker(['buildx', 'version']);
	if (buildx.code !== 0) {
		return { ok: false, refused: true, message: "This Docker has no buildx, which builds for linux/arm64. Update Docker Desktop, or install the buildx plugin." };
	}

	let scratch: { dir: string; file(name: string): string } | null = null;
	try {
		// Asked first, so a plan without containers says so before a build, not after one.
		let ticket = await uploadTicket(api, ref, name);
		scratch = await host.scratch();
		const archive = scratch.file('image.tar');
		say(`Building ${form.folder} for linux/arm64…`);
		const output: string[] = [];
		const built = await host.docker(buildArgs({ context: form.folder, archive }), {
			onLine(line) {
				output.push(line);
				say(line);
			},
		});
		if (built.code !== 0) {
			return { ok: false, refused: false, message: buildFailure(output.length ? output.join('\n') : `${built.stderr}\n${built.stdout}`) };
		}
		const size = await host.fileSize(archive).catch(() => -1);
		if (size <= 0) {
			return { ok: false, refused: false, message: "Docker finished but wrote no image archive, so there is nothing to upload." };
		}
		if (size > MAX_UPLOAD_BYTES) {
			return { ok: false, refused: true, message: `The image is ${megabytes(size)}, and a container's image may be at most 1 GB compressed. A slimmer base (alpine, distroless, -slim) usually fixes it.` };
		}
		// A long build can outlast the link: ask again rather than upload to one about to run out.
		if (!(Date.parse(ticket.expiresAt) - host.now() > TICKET_MARGIN_MS)) {
			ticket = await uploadTicket(api, ref, name);
		}
		say(`Uploading the image (${megabytes(size)})…`);
		let reported = 0;
		const answer = await host.upload(ticket.url, archive, (bytes) => {
			const quarter = Math.floor((bytes / size) * 4);
			if (quarter > reported && quarter < 4) {
				reported = quarter;
				say(`Uploaded ${megabytes(bytes)} of ${megabytes(size)}`);
			}
		});
		if (answer.status !== 200) {
			return { ok: false, refused: answer.status === 401 || answer.status === 413 || answer.status === 422, message: uploadFailure(answer.status, answer.body) };
		}
		let digest = '';
		try {
			digest = String((JSON.parse(answer.body) as { digest?: unknown }).digest ?? '');
		} catch {
			// Checked below.
		}
		if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
			return { ok: false, refused: false, message: "The upload finished without saying what it stored, so there is nothing to deploy. Build again." };
		}
		say(`Uploaded ${digest.slice(0, 19)}…. Deploying…`);
		const deployed = await api.request('cloud-project-containers', {
			ref, action: 'deploy', name, pushed: digest, ...(form.port === undefined ? {} : { port: form.port }),
		});
		return { ok: true, data: containerListing(deployed) };
	} catch (error) {
		return { ok: false, refused: error instanceof CloudRequestError && error.refused, message: withoutCloudInternals(detailFrom(error)) };
	} finally {
		if (scratch) {
			await host.removeDir(scratch.dir).catch(() => undefined);
		}
	}
}
