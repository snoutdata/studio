/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionFormValues, ImportItem, ImportItemRef, ImportScanResult } from '../shared/forms';
import type { ConnectionConfig } from '../shared/connection';
import { detailFrom, type CloudApi, type CloudProjectSummary } from './cloudApi';

// Import connections from SnoutData Cloud.
//
// A fourth import SOURCE rather than a feature of its own, and that is the whole design.
// The other three read a file that another tool wrote; this one asks the control plane.
// Everything after that is identical — the same `ImportItem`, the same picker, the same
// `connections.save`, the same keychain — so nothing below the sidebar learns that a
// hosted database exists. That matters because a change that cannot reach the rest of the app
// cannot break the rest of the app.
//
// ## Two things it does that a file importer cannot
//
// **Being signed in is the whole credential.** There is no connection string to paste and
// no password to type: the account already owns these databases, so the list comes from
// `cloud-project-list` and the password from `cloud-project-connection`, both with the
// user's own JWT, and RLS is what decides what comes back. A signed-out user gets a
// sentence rather than an empty list, because "no projects" and "you are not signed in"
// are different answers and only one of them is the user's to fix.
//
// **A re-import UPDATES rather than duplicates.** Every connection made here is tagged
// with its `cloudProjectRef`, so importing twice — after a password reset, after a rename
// — writes to the same connection instead of leaving two beside each other with one of
// them quietly broken. That tag is the only thing anywhere that knows this connection
// came from the cloud.
//
// ## What it deliberately does not do
//
// It does not keep anything in sync. An imported connection is an ordinary connection
// from the moment it is saved, and it goes stale exactly as a pasted one would; the fix
// is to import again, which is one click and is why the tag exists. We rejected the
// alternative (cloud projects appearing automatically, kept in step by the auth refresh) as a
// thing that is hard to reason about and impossible to turn off.

/** The connection this project would become. Pure, so the preview and the apply agree. */
export function projectToValues(project: CloudProjectSummary): ConnectionFormValues {
	return {
		label: project.name,
		driver: 'postgres',
		host: project.host,
		port: 5432,
		database: project.database,
		username: project.user,
		// TLS on, verified against the system trust store rather than the bundled Amazon
		// RDS CA: the front door's certificate is Let's Encrypt, and pointing the RDS
		// bundle at it would fail to verify a perfectly good chain.
		ssl: true,
		sslMode: 'system',
		// A project the user marked production carries that through, so the desktop's own
		// prod guard applies to it without anybody setting it twice.
		environment: project.production ? 'prod' : undefined,
		// Over its plan's storage quota, so the database itself is refusing writes. Saying
		// so on the connection means the grid explains it instead of the user meeting a
		// "read-only transaction" error with no context.
		readOnly: project.readOnly === true,
		cloudProjectRef: project.ref,
	};
}

/** A sentence about this project's state, or nothing when there is nothing worth saying. */
function noteFor(project: CloudProjectSummary, existing: ConnectionConfig | undefined): string | undefined {
	const parts: string[] = [];
	if (existing) {
		parts.push(`updates "${existing.label}"`);
	}
	if (project.readOnly) {
		parts.push("over its storage quota, so it is refusing writes");
	} else if (project.state === 'paused' || !project.wakesInstantly) {
		// Worth saying because the first connection will be slow and look broken
		// otherwise; the front door wakes it while the client waits.
		parts.push("paused, so the first connection wakes it and takes a few seconds");
	} else if (project.state !== 'ready') {
		parts.push(project.state);
	}
	return parts.length > 0 ? parts.join('; ') : undefined;
}

/**
 * List the signed-in account's hosted databases as importable connections.
 *
 * Never called on the boot path: a scan happens when the user opens the import screen and
 * picks this source, which is the rule "Startup is sacred" applied to a network call.
 */
export async function scanSnoutdataCloud(api: CloudApi, existing: ConnectionConfig[]): Promise<ImportScanResult> {
	const empty: ImportScanResult = { sourceId: 'snoutdata-cloud', sources: [], items: [] };

	const account = await api.account();
	if (!account) {
		// Not an error and not an empty list: an empty list would read as "you have no
		// databases", which is a different and discouraging thing to be told.
		return { ...empty, unavailable: "Sign in to SnoutData to import your hosted databases." };
	}

	let projects: CloudProjectSummary[];
	try {
		projects = await api.list();
	} catch (error) {
		return { ...empty, unavailable: `Could not reach SnoutData Cloud: ${detailFrom(error)}` };
	}

	if (projects.length === 0) {
		return {
			...empty,
			sources: [account],
			unavailable: "This account has no hosted databases yet. Create one from the Cloud panel.",
		};
	}

	const byRef = new Map(existing.filter((c) => c.cloudProjectRef).map((c) => [c.cloudProjectRef!, c]));
	const items: ImportItem[] = projects
		// A deleted project is still listed for a while so its owner can see what happened
		// to it; it is not something to make a connection to.
		.filter((project) => project.state !== 'deleted')
		.map((project) => {
			const already = byRef.get(project.ref);
			const values = projectToValues(project);
			if (already) {
				// The SAME connection, edited — which is what makes a second import a
				// refresh rather than a duplicate with a stale password beside it.
				values.id = already.id;
				values.label = already.label;
			}
			return {
				key: project.ref,
				values,
				sourceName: project.name,
				supported: true,
				// "Already imported", not "clashes with something": re-importing is the
				// supported way to pick up a reset password, so it is offered, not warned
				// about. The note says which connection it will write to.
				duplicate: already !== undefined,
				// Always: the account owns these databases and the control plane hands the
				// password to any signed-in client that asks.
				importsPassword: true,
				ref: { file: 'snoutdata-cloud', connId: project.ref },
				note: noteFor(project, already),
			};
		});

	return { sourceId: 'snoutdata-cloud', sources: [account], items };
}

/**
 * Fetch each chosen project's credentials and return connections ready to save.
 *
 * The password is fetched HERE, in main, and put straight on the form values the caller
 * saves — the same path a DBeaver password takes. It never goes to the renderer, and the
 * import screen never had it: the scan above deliberately does not ask for it, so opening
 * the picker does not read anybody's credentials out of the control plane.
 */
export async function resolveSnoutdataCloudImport(
	api: CloudApi,
	refs: ImportItemRef[],
	existing: ConnectionConfig[],
): Promise<ConnectionFormValues[]> {
	const byRef = new Map(existing.filter((c) => c.cloudProjectRef).map((c) => [c.cloudProjectRef!, c]));

	// The list again, for the name and the quota state. `cloud-project-connection` returns
	// a credential and nothing else — rightly, it is the most sensitive call in the API —
	// so without this the connection would be labelled with its ref rather than "first
	// light", and an over-quota project would not be marked read-only.
	//
	// It also means the values saved come from `projectToValues`, the SAME function the
	// preview was built from, with only the password added. A second mapping here is how
	// a picker ends up promising one thing and saving another.
	const listed = new Map<string, CloudProjectSummary>();
	try {
		for (const project of await api.list()) {
			listed.set(project.ref, project);
		}
	} catch {
		// Not fatal. A missing name costs a label; a missing password costs the import,
		// and that call is below and is allowed to throw.
	}

	const out: ConnectionFormValues[] = [];
	for (const ref of refs) {
		// Sequential rather than parallel on purpose: reading a project's connection
		// details is on the audit log as `project.connection.read`, and a burst of them is
		// harder to read afterwards than a sequence. Nobody imports a hundred databases.
		const details = await api.connection(ref.connId);
		const project = listed.get(details.ref);
		const already = byRef.get(details.ref);

		const values: ConnectionFormValues = project
			? projectToValues(project)
			: {
					label: details.ref,
					driver: 'postgres',
					host: details.host,
					port: details.port,
					database: details.database,
					username: details.user,
					ssl: true,
					sslMode: 'system',
					readOnly: false,
					cloudProjectRef: details.ref,
				};

		// The credential the control plane just handed us, and the address IT gave rather
		// than the one the list did: the connection call is the authority on where a
		// project answers, and they can differ while a project is moving.
		values.password = details.password;
		values.host = details.host;
		values.port = details.port;
		values.database = details.database;
		values.username = details.user;
		if (already) {
			// Write to the connection that already exists rather than beside it, and keep
			// the name the user gave it: they renamed it for a reason, and an import is
			// not the moment to overrule that.
			values.id = already.id;
			values.label = already.label;
			// And what the user decided the AI may see of it: a re-import must never widen that.
			values.aiDataAccess = already.aiDataAccess;
		}
		out.push(values);
	}
	return out;
}
