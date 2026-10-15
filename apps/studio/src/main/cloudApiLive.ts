/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { CloudRequestError, cloudTimeoutFor, detailFrom, type CloudActionResult, type CloudApi, type CloudProjectFunction, type CloudConnectionDetails, type CloudExportStatus, type CloudMintedToken, type CloudProjectSummary } from './cloudApi';
import { getCloudClient } from './cloudClient';

// The real SnoutData Cloud API, and the only part of the import that reaches Electron.
//
// Split from `cloudImport.ts` so that everything which DECIDES — a signed-out user, an
// account with no projects, a project already imported, one that has been deleted — is
// pure and provable without a network. `shared/engine/host.ts` states the rule; this is
// it applied to the desktop's half of the Cloud import.
//
// Every call carries the user's own session, so RLS is what decides what comes back.
// There is no service key here and no path that reads a project "because the app asked".

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("SnoutData Cloud did not answer in time")), ms);
		p.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

async function invoke<T>(name: string, body: Record<string, unknown> = {}, method: 'POST' | 'GET' = 'POST'): Promise<T> {
	// A GET carries its arguments in the query string: `cloud-project-export` answers a GET without
	// starting anything, which is what a poll must be.
	const request = method === 'GET' ? { method } : { body };
	const timeoutMs = cloudTimeoutFor(name);
	let { data, error } = await withTimeout(getCloudClient().fn.call(name, request), timeoutMs);
	// A session the control plane refused once ("Invalid token", seen live on 2026-10-03 with a
	// token refreshed twelve minutes earlier) is refreshed and asked once more, so a section does
	// not open on an error that the next click would not show. A refresh that fails leaves the
	// first refusal standing.
	if (error && (error as { context?: Response }).context?.status === 401) {
		const refreshed = await getCloudClient().identity.renew().catch(() => null);
		if (refreshed?.data.session) {
			({ data, error } = await withTimeout(getCloudClient().fn.call(name, request), timeoutMs));
		}
	}
	if (error) {
		// The client hides the body on a non-2xx; the function's own sentence is the useful
		// part and the STATUS is what says whether we were refused or something broke.
		const context = (error as { context?: Response }).context;
		const status = context?.status ?? 0;
		const detail = context
			? await context.clone().json().then((body) => (body as { error?: string })?.error).catch(() => undefined)
			: undefined;
		throw new CloudRequestError(detail ?? detailFrom(error), status);
	}
	const payload = data as (T & { error?: string }) | null;
	if (!payload || payload.error) {
		throw new Error(payload?.error ?? "SnoutData Cloud returned nothing");
	}
	return payload;
}

/**
 * A fake control plane on 127.0.0.1, for the e2e suite only.
 *
 * Gated exactly like the reviewer's fake GitHub (`review/githubClient.ts`): the address is
 * honoured ONLY when `SNOUT_E2E_USERDATA` has already pointed the profile at a scratch
 * directory, so nothing in a normal run can be aimed anywhere but SnoutData Cloud. A
 * packaged build sets neither and this branch is unreachable.
 *
 * It exists so the Cloud panel and the import picker can be DRIVEN — the real panel, the
 * real IPC, the real decisions in `cloudProjects.ts` — against states that are otherwise
 * hard to produce on demand: a paused project, one mid-flight, one over its quota, a
 * production project refusing a stop, and an account that is signed out. It does NOT
 * replace connecting to a real hosted database: it proves our half of the conversation,
 * not that the control plane's payloads are the shapes we assume.
 */
function e2eCloudApi(base: string): CloudApi {
	async function call<T>(path: string, body: unknown = {}): Promise<T> {
		const response = await fetch(`${base}/${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const payload = (await response.json()) as T & { error?: string };
		if (!response.ok || payload.error) {
			throw new CloudRequestError(payload.error ?? `${path} failed (${response.status})`, response.status);
		}
		return payload;
	}
	return {
		async account() {
			const { account } = await call<{ account: string | null }>('account');
			return account;
		},
		async list() {
			const { projects } = await call<{ projects: CloudProjectSummary[] }>('cloud-project-list');
			return projects ?? [];
		},
		connection: (ref) => call<CloudConnectionDetails>('cloud-project-connection', { ref }),
		pause: (ref) => call<CloudActionResult>('cloud-project-pause', { ref }),
		resume: (ref) => call<CloudActionResult>('cloud-project-resume', { ref }),
		mintToken: (name) => call<CloudMintedToken>('cloud-token-create', { name }),
		create: (name, region, options) => call<{ project: CloudProjectSummary }>('cloud-project-create', { name, region, production: options?.production === true }),
		requestExport: async (ref) => (await call<{ export: CloudExportStatus }>('cloud-project-export', { ref })).export,
		exportStatus: async (ref) => (await call<{ export: CloudExportStatus }>('cloud-project-export-status', { ref })).export,
		remove: (ref) => call<CloudActionResult>('cloud-project-delete', { ref }),
		request: <T>(fn: CloudProjectFunction, body: Record<string, unknown>) => call<T>(fn, body),
	};
}

const realCloudApi: CloudApi = {
	async account(): Promise<string | null> {
		const { data } = await getCloudClient().identity.currentSession();
		const session = data.session;
		if (!session) {
			return null;
		}
		// An account with no email on its token is still an account; falling back keeps
		// the import working rather than reporting the user as signed out.
		return session.person.email ?? "your account";
	},

	async list(): Promise<CloudProjectSummary[]> {
		const payload = await invoke<{ projects: CloudProjectSummary[] }>('cloud-project-list');
		return payload.projects ?? [];
	},

	connection(ref: string): Promise<CloudConnectionDetails> {
		return invoke<CloudConnectionDetails>('cloud-project-connection', { ref });
	},

	// Both set a DESIRED state and return. The host agent does the work on its next tick,
	// so what comes back is what was asked for, not what is true yet.
	pause(ref: string): Promise<CloudActionResult> {
		return invoke<CloudActionResult>('cloud-project-pause', { ref });
	},

	resume(ref: string): Promise<CloudActionResult> {
		return invoke<CloudActionResult>('cloud-project-resume', { ref });
	},

	// The app holds a SESSION, which is the one thing a token does not buy, so this is the only
	// place in the product that can bootstrap a credential.
	mintToken(name: string): Promise<CloudMintedToken> {
		return invoke<CloudMintedToken>('cloud-token-create', { name });
	},

	// The Cloud panel's New Project and Delete, and moving a database.
	create(name: string, region: string, options?: { production?: boolean }): Promise<{ project: CloudProjectSummary }> {
		return invoke<{ project: CloudProjectSummary }>('cloud-project-create', { name, region, production: options?.production === true });
	},

	async requestExport(ref: string): Promise<CloudExportStatus> {
		return (await invoke<{ export: CloudExportStatus }>('cloud-project-export', { ref })).export;
	},

	async exportStatus(ref: string): Promise<CloudExportStatus> {
		return (await invoke<{ export: CloudExportStatus }>(`cloud-project-export?ref=${encodeURIComponent(ref)}`, {}, 'GET')).export;
	},

	remove(ref: string): Promise<CloudActionResult> {
		return invoke<CloudActionResult>('cloud-project-delete', { ref });
	},

	request<T>(fn: CloudProjectFunction, body: Record<string, unknown>, method: 'POST' | 'GET' = 'POST'): Promise<T> {
		if (method === 'GET') {
			const query = new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, String(v)])).toString();
			return invoke<T>(`${fn}?${query}`, {}, 'GET');
		}
		return invoke<T>(fn, body);
	},
};

/**
 * The control plane this app talks to.
 *
 * The scratch-profile gate is the whole safety of the fake: `SNOUT_E2E_CLOUD_API` alone
 * does nothing, and a packaged build reads neither, so a stray environment variable on a real
 * machine cannot point a signed-in user's desktop at somebody else's server.
 */
const e2eBase = !app.isPackaged && process.env.SNOUT_E2E_USERDATA && process.env.SNOUT_E2E_CLOUD_API;
export const liveCloudApi: CloudApi = e2eBase ? e2eCloudApi(e2eBase) : realCloudApi;
