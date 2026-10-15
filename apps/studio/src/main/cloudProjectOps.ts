/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CloudRequestError, detailFrom, type CloudApi, type CloudConnectionDetails } from './cloudApi';
import type {
	CloudBackups, CloudConnectionFacts, CloudCopyTarget, CloudDomain, CloudExport, CloudFunctions,
	CloudProjectOp, CloudProjectOps, CloudProjectOutcome, CloudRestoreWindow, CloudSecretRow, CloudServices, CloudUsage,
} from '../shared/cloudProjects';
import type { CloudContainerAllowance, CloudContainerLogLine, CloudContainers } from '../shared/cloudContainers';

// The Cloud project tab's half in main: everything a project has beyond start and stop, one Snout
// Function per operation, the same ones the dashboard and the CLI call. Pure: the control plane is
// a `CloudApi`, and the two things only main may do (write the clipboard, store a password) are
// handed in.
//
// ## Secrets never reach the renderer
//
// A password and the two API keys go from the control plane to the CLIPBOARD, in main. The tab
// learns only that they exist. Reading them is `project.connection.read` on the audit log,
// so it happens when a person clicks Copy, and never to fill a screen.

export interface CloudProjectHost {
	/** Put text on the system clipboard. */
	copy(text: string): void;
	/** Store a new password on every connection made from this project; answers how many. */
	updatePassword(ref: string, password: string): Promise<number>;
	/** A new project exists (a restore): bring it in as a connection. */
	sync(): Promise<void>;
}

/** What `cloud-project-functions` answers, as far as this tab reads it. */
interface FunctionsListing {
	functions?: CloudFunctions['functions'];
	limit?: { tier?: string; functionMemoryMb?: number; concurrencyMax?: number; podMemoryMb?: number };
}

/** The plan's sizing numbers, or null from a control plane that does not size functions. */
export function functionPlan(listed: FunctionsListing): CloudFunctions['plan'] {
	const limit = listed.limit;
	if (!limit || limit.functionMemoryMb == null || limit.concurrencyMax == null || limit.podMemoryMb == null) {
		return null;
	}
	return { tier: limit.tier ?? 'this', functionMemoryMb: limit.functionMemoryMb, concurrencyMax: limit.concurrencyMax, podMemoryMb: limit.podMemoryMb };
}

type Handlers = { [K in CloudProjectOp]: (args: CloudProjectOps[K]['args']) => Promise<CloudProjectOps[K]['result']> };

function handlers(api: CloudApi, host: CloudProjectHost): Handlers {
	async function secrets(body: Record<string, unknown>): Promise<CloudSecretRow[]> {
		const answer = await api.request<{ secrets?: CloudSecretRow[] }>('cloud-project-secrets', body);
		return answer.secrets ?? [];
	}

	return {
		async usage({ ref }) {
			const answer = await api.request<Partial<CloudUsage>>('cloud-project-usage', { ref, days: 30 });
			return { days: answer.days ?? [], limit: answer.limit ?? null };
		},

		async connection({ ref }) {
			// Not `api.connection`: that is the password read, and this screen does not need it.
			const project = (await api.list()).find((p) => p.ref === ref);
			if (!project) {
				throw new CloudRequestError("This project is not in your account any more.", 404);
			}
			const facts: CloudConnectionFacts = {
				host: project.host,
				port: 5432,
				database: project.database,
				user: project.user,
			};
			return facts;
		},

		async copy({ ref, what }) {
			const details = await api.connection(ref) as CloudConnectionDetails & ProjectKeyFields & { uri?: string };
			host.copy(copyText(details, what));
			return { copied: what };
		},

		async resetPassword({ ref }) {
			const answer = await api.request<{ password: string; appliesIn: string }>('cloud-project-reset-password', { ref });
			const updatedConnections = await host.updatePassword(ref, answer.password);
			return { appliesIn: answer.appliesIn, updatedConnections };
		},

		async rotateKeys({ ref }) {
			const answer = await api.request<{ breaks?: string }>('cloud-project-rotate-jwt', { ref });
			return { breaks: answer.breaks ?? "Every key already in use stops working." };
		},

		async backups({ ref }) {
			// Two reads, each allowed to fail on its own: a plan with no point-in-time restore
			// still has exports, and saying nothing about either because one refused is worse.
			const [exported, restore] = await Promise.all([
				api.exportStatus(ref).catch(() => null),
				api.request<{ restore?: CloudRestoreWindow }>('cloud-project-restore', { ref }, 'GET').then((a) => a.restore ?? null).catch(() => null),
			]);
			const backups: CloudBackups = { export: exported as CloudExport | null, restore };
			return backups;
		},

		async requestExport({ ref }) {
			return await api.requestExport(ref) as CloudExport;
		},

		async restore({ ref, at, name }) {
			const answer = await api.request<{ project: { ref: string; name: string } }>('cloud-project-restore', { ref, at, ...(name ? { name } : {}) });
			// The copy is a new project: the sync is what makes it a connection.
			await host.sync().catch(() => undefined);
			return { ref: answer.project.ref, name: answer.project.name };
		},

		async services({ ref }) {
			const errors: CloudServices['errors'] = {};
			const [auth, storage, dataApi, push] = await Promise.all([
				api.request<{ enabled?: boolean; google?: { enabled?: boolean }; saml?: { enabled?: boolean } }>('cloud-project-auth', { ref, action: 'status' })
					.then((a) => ({ enabled: a.enabled === true, googleEnabled: a.google?.enabled === true, samlEnabled: a.saml?.enabled === true }))
					.catch((e) => { errors.auth = detailFrom(e); return null; }),
				api.request<{ storage?: { enabled: boolean; pending: boolean; bytes: number | null; files: number | null; lastError: string | null; limit?: { maxFilesBytes: number | null } } }>('cloud-project-storage', { ref })
					.then((a) => a.storage
						? { enabled: a.storage.enabled, pending: a.storage.pending, bytes: a.storage.bytes, files: a.storage.files, lastError: a.storage.lastError, maxFilesBytes: a.storage.limit?.maxFilesBytes ?? null }
						: null)
					.catch((e) => { errors.storage = detailFrom(e); return null; }),
				api.request<{ dataApi?: { enabled: boolean; allowed: boolean } }>('cloud-project-data-api', { ref })
					.then((a) => a.dataApi ? { enabled: a.dataApi.enabled, allowed: a.dataApi.allowed } : null)
					.catch((e) => { errors.dataApi = detailFrom(e); return null; }),
				api.request<{ push?: { enabled: boolean; scheduling: boolean } }>('cloud-project-push', { ref })
					.then((a) => a.push ? { enabled: a.push.enabled, scheduling: a.push.scheduling } : null)
					// A control plane older than push has no such function and answers 404: that is
					// "not available yet", said plainly, not an error to puzzle over.
					.catch((e) => { errors.push = e instanceof CloudRequestError && e.status === 404 ? "Push is not available on SnoutData Cloud yet." : detailFrom(e); return null; }),
			]);
			return { auth, storage, dataApi, push, errors };
		},

		async setService({ ref, service, enable }) {
			if (service === 'auth') {
				const answer = await api.request<{ note?: string }>('cloud-project-auth', { ref, action: enable ? 'enable' : 'disable' });
				return { note: answer.note ?? null };
			}
			if (service === 'push') {
				await api.request('cloud-project-push', { ref, enable });
				return { note: enable ? "Turned on. Push runs beside the database, so the database restarts once, within a minute." : null };
			}
			await api.request(service === 'storage' ? 'cloud-project-storage' : 'cloud-project-data-api', { ref, enable });
			return { note: null };
		},

		async functions({ ref }) {
			const [listed, secretRows] = await Promise.all([
				api.request<FunctionsListing>('cloud-project-functions', { ref }),
				secrets({ ref }),
			]);
			return { functions: listed.functions ?? [], secrets: secretRows, plan: functionPlan(listed) };
		},

		// The control plane judges the size (checkFunctionSize, then the database) and refuses in its
		// own words; nothing here repeats the rule.
		async sizeFunction({ ref, name, memoryMb, concurrency, reset }) {
			const body = reset ? { ref, action: 'size', name, reset: true } : { ref, action: 'size', name, memoryMb: memoryMb ?? null, concurrency: concurrency ?? null };
			const [sized, secretRows] = await Promise.all([
				api.request<FunctionsListing>('cloud-project-functions', body),
				secrets({ ref }),
			]);
			return { functions: sized.functions ?? [], secrets: secretRows, plan: functionPlan(sized) };
		},

		async setSecret({ ref, name, value }) {
			await secrets({ ref, action: 'set', name, value });
			return secrets({ ref });
		},

		async unsetSecret({ ref, name }) {
			await secrets({ ref, action: 'unset', name });
			return secrets({ ref });
		},

		async domains({ ref }) {
			const answer = await api.request<{ domains?: CloudDomain[] }>('cloud-project-domain', { ref, action: 'list' });
			return answer.domains ?? [];
		},

		// The cluster's every operation is the router's; this only carries it.
		async shards({ ref, ...rest }) {
			return api.request<Record<string, unknown>>('cloud-project-shards', { ref, ...rest });
		},

		// Snout Containers: the endpoint answers the listing after every write, so each of these
		// hands the tab what is true now.
		async containers({ ref }) {
			return containerListing(await api.request('cloud-project-containers', { ref }));
		},

		async deployContainer(args) {
			return containerListing(await api.request('cloud-project-containers', deployBody(args)));
		},

		async restartContainer({ ref, name }) {
			return containerListing(await api.request('cloud-project-containers', { ref, action: 'restart', name }));
		},

		async removeContainer({ ref, name }) {
			return containerListing(await api.request('cloud-project-containers', { ref, action: 'delete', name }));
		},

		async containerLogs({ ref, name, errorsOnly, limit }) {
			const answer = await api.request<{ lines?: CloudContainerLogLine[] }>('cloud-project-containers', {
				ref, action: 'logs', name, ...(errorsOnly ? { errorsOnly: true } : {}), limit: limit ?? 200,
			});
			return answer.lines ?? [];
		},

		async domain({ ref, action, hostname }) {
			const answer = await api.request<{ domain?: CloudDomain; next?: string }>('cloud-project-domain', { ref, action, hostname });
			return { domain: answer.domain ?? null, next: answer.next ?? null };
		},
	};
}

/** What `cloud-project-containers` answers, read defensively: a field it did not send is a default, not a crash. */
export function containerListing(answer: unknown): CloudContainers {
	const raw = (answer ?? {}) as { allowance?: Partial<CloudContainerAllowance> | null; containers?: unknown };
	const allowance = raw.allowance
		? {
			deployed: Number(raw.allowance.deployed ?? 0),
			maxContainers: Number(raw.allowance.maxContainers ?? 0),
			memoryMb: Number(raw.allowance.memoryMb ?? 0),
			cpuPercent: Number(raw.allowance.cpuPercent ?? 0),
			egress: raw.allowance.egress ?? null,
		}
		: null;
	const containers = Array.isArray(raw.containers) ? raw.containers as CloudContainers['containers'] : [];
	return {
		allowance,
		containers: containers.map((c) => ({
			...c,
			built: c.built === true,
			port: Number(c.port),
			restarts: Number(c.restarts ?? 0),
			statusDetail: c.statusDetail ?? null,
			statusAt: c.statusAt ?? null,
			updatedAt: c.updatedAt ?? null,
			privateRegistry: c.privateRegistry === true,
			allowed: c.allowed !== false,
		})),
	};
}

/**
 * A deploy's body: a registry image or a pushed digest, never both, and a registry login only
 * when a user name was typed (the endpoint takes a user and a token together, or neither).
 */
export function deployBody(args: CloudProjectOps['deployContainer']['args']): Record<string, unknown> {
	const user = args.registryUser?.trim() ?? '';
	if (args.pushed && args.image) {
		throw new CloudRequestError("A deploy is an image or a build, not both.", 400);
	}
	if (!args.pushed && !args.image?.trim()) {
		throw new CloudRequestError("Name the image to deploy.", 400);
	}
	return {
		ref: args.ref,
		action: 'deploy',
		name: args.name.trim(),
		...(args.pushed ? { pushed: args.pushed } : { image: args.image!.trim() }),
		...(args.port === undefined ? {} : { port: args.port }),
		...(user && !args.pushed ? { registryUser: user, registryPassword: args.registryPassword ?? '' } : {}),
		...(args.clearCredential ? { clearCredential: true } : {}),
	};
}

/** The keys `cloud-project-connection` answers with. `anonKey` and `serviceRoleKey` are their earlier
 *  names, which a control plane not yet migrated to the new names sends alone; each is read as a
 *  fallback for the new one. */
export interface ProjectKeyFields {
	appKey?: string | null;
	serverKey?: string | null;
	anonKey?: string | null;
	serviceRoleKey?: string | null;
}

/** What Copy puts on the clipboard. The URI is built here when the control plane did not send one. */
export function copyText(details: CloudConnectionDetails & ProjectKeyFields & { uri?: string }, what: CloudCopyTarget): string {
	switch (what) {
		case 'password':
			return details.password;
		case 'uri':
			return details.uri
				?? `postgres://${details.user}:${encodeURIComponent(details.password)}@${details.host}:${details.port}/${details.database}?sslmode=require`;
		case 'appKey':
		case 'serverKey': {
			const key = what === 'appKey' ? details.appKey ?? details.anonKey : details.serverKey ?? details.serviceRoleKey;
			if (!key) {
				throw new CloudRequestError("This project has no API keys yet. Try again in a moment.", 409);
			}
			return key;
		}
	}
}

/** Run one operation, turning a throw into a refusal or a failure the tab can colour. */
export async function runCloudProjectOp<K extends CloudProjectOp>(
	api: CloudApi,
	host: CloudProjectHost,
	op: K,
	args: CloudProjectOps[K]['args'],
): Promise<CloudProjectOutcome<CloudProjectOps[K]['result']>> {
	const table = handlers(api, host);
	const handler = table[op] as unknown as ((a: CloudProjectOps[K]['args']) => Promise<CloudProjectOps[K]['result']>) | undefined;
	if (!handler) {
		return { ok: false, refused: true, message: `Unknown operation: ${String(op)}` };
	}
	try {
		return { ok: true, data: await handler(args) };
	} catch (error) {
		return { ok: false, refused: error instanceof CloudRequestError && error.refused, message: detailFrom(error) };
	}
}
