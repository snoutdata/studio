/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CloudStore } from '../cloudStore';
import { objectStoreFor, objectStoreServices, type ObjectStoreDriver } from './objectStore';
import { logSourceFor, logSourceServices, type LogSourceDriver } from './logSource';
import { cloudVendorInfo, cloudVendors, importableFor } from './vendors';
import {
	cloudSecretId,
	serviceFor,
	type CloudAccount,
	type CloudAccountForm,
	type CloudAccountView,
	type CloudContainerList,
	type CloudTestResult,
	type CloudVendor,
	type CloudVendorInfo,
	type ImportableCredential,
	type LogScopeList,
	type LogServiceInfo,
	TELEMETRY_SERVICES,
} from '../../shared/cloud';
import type { VerifyCloudAccountParams, VerifyCloudAccountResult } from '../../shared/protocol';
import type { SecretStore } from '../secretStore';

/*---------------------------------------------------------------------------------------------
 *  What the renderer is allowed to ask about cloud storage.
 *
 *  One object so `index.ts` stays a wiring file, and driver-agnostic by construction: every method
 *  goes through `objectStoreFor(account.vendor)` or `logSourceFor(account.vendor)` and nothing here
 *  names a vendor. An account is a CREDENTIAL: which service a flow points it at is decided on the
 *  flow, so this surface answers "what can this account do" and never "what kind of account is it".
 *
 *  The rule that shapes the whole surface: **a secret goes in and never comes out.** `save` takes an
 *  optional secret and puts it in the keychain; nothing here returns one, and there is no
 *  `getSecret`. The renderer can ask WHETHER an account has one, which is the same split
 *  `learn:hasToken` already makes for the same reason.
 *--------------------------------------------------------------------------------------------*/

/** One service's answer to Test, with the name to call it by when it is not the only one asked. */
interface TestedService extends CloudTestResult {
	label: string;
}

/** Signs an account in to a log service through the server child's telemetry plugins
 *  (`snout/verifyCloudAccount`): what Test falls back to in a build with no storage or log-source
 *  driver of its own, which is the open-source one, where those drivers are Data Flows. */
export type VerifyCloudAccount = (params: VerifyCloudAccountParams) => Promise<VerifyCloudAccountResult>;

export class CloudService {
	constructor(
		private readonly store: CloudStore,
		private readonly secrets: SecretStore,
		private readonly verifyAccount?: VerifyCloudAccount,
	) {}

	/** Every vendor, with the services this build can do for it, so a picker declines honestly
	 *  rather than hiding an arm. What Settings lists. */
	vendors(): CloudVendorInfo[] {
		return cloudVendors();
	}

	list(): CloudAccountView[] {
		return this.store.list().map((account) => this.withSecretFlag(account));
	}

	/** Store an account, and its secret if one was typed. Returns the view, never the secret. */
	save(form: CloudAccountForm): CloudAccountView {
		const stored = this.store.save(form.account);
		if (typeof form.secret === 'string' && form.secret.length > 0) {
			this.secrets.store(cloudSecretId(stored.id), 'awsSecretAccessKey', form.secret);
		} else if (form.secret === null) {
			this.secrets.delete(cloudSecretId(stored.id), 'awsSecretAccessKey');
		}
		return this.withSecretFlag(stored);
	}

	/** Forget an account AND its secret. Leaving the keychain entry behind would be a credential
	 *  nothing can see and nothing can remove. */
	remove(id: string): void {
		this.store.remove(id);
		this.secrets.delete(cloudSecretId(id), 'awsSecretAccessKey');
	}

	/**
	 * Can this app reach this account, tested against what the user is LOOKING at rather than what
	 * is saved, so Test works before Save, which is the order anybody does it in.
	 *
	 * It asks EVERY service this build can do for the vendor and passes when ANY ONE of them
	 * answers, because an account is a VENDOR credential and which service it gets pointed at is
	 * decided later, on the flow or the connection. A key scoped to CloudWatch alone is a working
	 * key: failing it for not also listing buckets refuses the credential the next screen actually
	 * needs, and says so in the words of a service the user never asked for.
	 *
	 * Each arm makes the same call that service's picker makes, so a green tick is that call
	 * working rather than a claim about permissions in general.
	 */
	async test(form: CloudAccountForm): Promise<CloudTestResult> {
		const arms = await Promise.all([
			objectStoreFor(form.account.vendor) ? this.testObjectStore(form) : undefined,
			logSourceFor(form.account.vendor) ? this.testLogs(form) : undefined,
		]);
		const tried = arms.filter((arm): arm is TestedService => arm !== undefined);
		if (tried.length === 0) {
			return this.testSignIn(form);
		}
		const worked = tried.filter((arm) => arm.ok);
		if (worked.length === 0) {
			// Nothing answered, so say why for each: one credential can fail two services for two
			// different reasons, and picking one of them to report hides the other. And say the
			// thing every one of those sentences leaves out: listing is its OWN permission, so a
			// credential scoped to particular resources fails all of them and can still do the work.
			const logs = logSourceFor(form.account.vendor);
			const scoped = logs
				? ` Listing is its own permission. If these credentials are scoped to particular ${logs.info.scopeNoun}s rather than the whole account, name those on the connection and it will read them without asking for the list.`
				: '';
			return { ok: false, message: tried.map((arm) => arm.message).join(' ') + scoped };
		}
		// One service working is a pass. The ones that did not answer are still reported, because a
		// user who meant to reach that one needs to know, but they are not a failure of the account.
		const missing = tried
			.filter((arm) => !arm.ok)
			.map((arm) => `${arm.label} did not answer: ${arm.message}`);
		return {
			ok: true,
			message: [...worked.map((arm) => arm.message), ...missing].join(' '),
			sample: worked.flatMap((arm) => arm.sample ?? []).slice(0, 3),
		};
	}

	/**
	 * Test with no driver here to test with (the open-source build, which has no Data Flows and so
	 * none of the storage or log-source drivers): do the credentials SIGN IN, to the log service a
	 * connection would use them for. No region, workspace or project is needed yet; the connection
	 * chooses that, and its own Test checks it. Passes when any of the vendor's services signs in.
	 */
	private async testSignIn(form: CloudAccountForm): Promise<CloudTestResult> {
		const services = Object.values(TELEMETRY_SERVICES).filter((service) => service.vendor === form.account.vendor);
		const verify = this.verifyAccount;
		if (services.length === 0 || !verify) {
			return { ok: false, message: this.notBuilt(form.account.vendor, 'objectStore') };
		}
		const secret = this.secretFrom(form);
		const answers = await Promise.all(services.map(async (service) => ({
			service,
			answer: await verify({ service: service.service, account: form.account, secret }).catch((err: unknown): VerifyCloudAccountResult => ({
				ok: false,
				message: err instanceof Error ? err.message : String(err),
			})),
		})));
		const signedIn = answers.find((entry) => entry.answer.ok);
		if (signedIn) {
			const { label, containerNoun } = signedIn.service;
			return { ok: true, message: `Signed in to ${label}. Choose the ${containerNoun} on the connection.` };
		}
		return { ok: false, message: answers.map((entry) => entry.answer.message ?? `${entry.service.label} did not answer.`).join(' ') };
	}

	/** Test the FILES arm, by listing the containers its picker lists. */
	private async testObjectStore(form: CloudAccountForm): Promise<TestedService> {
		const driver = objectStoreFor(form.account.vendor);
		if (!driver) {
			return { ok: false, label: '', message: this.notBuilt(form.account.vendor, 'objectStore') };
		}
		const label = driver.info.label;
		const session = driver.open(form.account, this.secretFrom(form));
		try {
			const containers = await session.listContainers();
			const noun = driver.info.containerNoun;
			const where = form.account.endpoint ? `the storage at ${form.account.endpoint}` : label;
			if (containers.length === 0) {
				// Reachable with nothing in it is a success, not a failure: an account with no
				// containers is a legitimate state, and "failed" would send somebody off to check
				// credentials that are working perfectly.
				return { ok: true, label, message: `Connected to ${where}. This account has no ${noun}s yet.` };
			}
			return {
				ok: true,
				label,
				message: `Connected to ${where}. ${containers.length === 1 ? `One ${noun}` : `${containers.length} ${noun}s`} visible.`,
				sample: containers.slice(0, 3).map((container) => container.name),
			};
		} catch (err) {
			return { ok: false, label, message: driver.explain(err, form.account) };
		} finally {
			session.close();
		}
	}

	/**
	 * Every container the form's credentials can see, so nobody types a bucket name or a region.
	 *
	 * Answered against what is ON SCREEN for the same reason Test is: this is the step before
	 * saving, and requiring a save first would mean saving an account to find out it does not work.
	 */
	async containers(form: CloudAccountForm): Promise<CloudContainerList> {
		const driver = objectStoreFor(form.account.vendor);
		if (!driver) {
			return { ok: false, containers: [], message: this.notBuilt(form.account.vendor, 'objectStore') };
		}
		const session = driver.open(form.account, this.secretFrom(form));
		try {
			return { ok: true, containers: await session.listContainers() };
		} catch (err) {
			return { ok: false, containers: [], message: driver.explain(err, form.account) };
		} finally {
			session.close();
		}
	}

	/**
	 * Containers a SAVED account can see, for the flow wizard's picker.
	 *
	 * Separate from {@link containers} because the caller is different: the wizard holds an id and
	 * no form, and handing it a way to pass an arbitrary account would be a second door into the
	 * same credentials with nothing saved behind it.
	 */
	async containersFor(accountId: string): Promise<CloudContainerList> {
		const account = this.store.get(accountId);
		return account
			? this.containers({ account })
			: { ok: false, containers: [], message: 'That storage account is no longer set up.' };
	}

	/**
	 * Credentials this computer already has that a vendor can adopt without copying a secret.
	 *
	 * Read-only and secret-free by construction: a driver's `importable()` produces an auth that
	 * NAMES a local credential, never one that carries it.
	 */
	importable(vendor: CloudVendor): ImportableCredential[] {
		return importableFor(vendor);
	}

	/*-----------------------------------------------------------------------------------------
	 *  Logs.
	 *
	 *  A second service on the SAME account, with its own driver seam. Everything above is storage
	 *  and everything here is logs; an account whose vendor has no driver on one seam is simply not
	 *  offered by that seam's picker (`CloudVendorInfo.services` is what they filter on).
	 *----------------------------------------------------------------------------------------*/

	/** Every log service, built or not, so the wizard can render a driver's own nouns and decline
	 *  honestly for one that is declared and not built. */
	logServices(): LogServiceInfo[] {
		return logSourceServices();
	}

	/**
	 * Every scope a SAVED account can see in one region, for the flow wizard's picker.
	 *
	 * The region is a parameter rather than the account's, because a log scope is regional on every
	 * one of these providers and one credential commonly reads several. A bucket needed no such
	 * thing: `ListBuckets` is account-wide.
	 */
	async logScopesFor(accountId: string, region: string): Promise<LogScopeList> {
		const account = this.store.get(accountId);
		if (!account) {
			return { ok: false, scopes: [], message: 'That cloud account is no longer set up.' };
		}
		const driver = logSourceFor(account.vendor);
		if (!driver) {
			return { ok: false, scopes: [], message: this.notBuilt(account.vendor, 'logs') };
		}
		const scoped = { ...account, region: region || account.region };
		const session = driver.open(scoped, this.secretFor(accountId));
		try {
			return { ok: true, scopes: await session.listScopes() };
		} catch (err) {
			return { ok: false, scopes: [], message: driver.explain(err, scoped) };
		} finally {
			session.close();
		}
	}

	/** A saved account and the LOG driver that serves it, for the flow runner. Mirrors {@link resolve}. */
	resolveLog(accountId: string): { driver: LogSourceDriver; account: CloudAccount; secret: string | undefined } | undefined {
		const account = this.store.get(accountId);
		if (!account) {
			return undefined;
		}
		const driver = logSourceFor(account.vendor);
		return driver ? { driver, account, secret: this.secretFor(accountId) } : undefined;
	}

	/** A saved account by id, for the flow runner. */
	get(id: string): CloudAccount | undefined {
		return this.store.get(id);
	}

	/** A saved account and the driver that serves it, for the flow runner. The caller opens and
	 *  closes its own session, because a run holds one for the length of a read. */
	resolve(accountId: string): { driver: ObjectStoreDriver; account: CloudAccount; secret: string | undefined } | undefined {
		const account = this.store.get(accountId);
		if (!account) {
			return undefined;
		}
		const driver = objectStoreFor(account.vendor);
		return driver ? { driver, account, secret: this.secretFor(accountId) } : undefined;
	}

	/** The stored secret for an account. Main-only: this is the one thing that never crosses IPC. */
	secretFor(id: string): string | undefined {
		return this.secrets.get(cloudSecretId(id), 'awsSecretAccessKey');
	}

	/** The secret a form means: the typed one, nothing when it was cleared, else the stored one. */
	private secretFrom(form: CloudAccountForm): string | undefined {
		if (typeof form.secret === 'string' && form.secret.length > 0) {
			return form.secret;
		}
		return form.secret === null ? undefined : this.secretFor(form.account.id);
	}

	/**
	 * Why a vendor cannot do this, named as the SERVICE the user was reaching for.
	 *
	 * "Google Cloud is not built yet" is false the day one of its two services works, so the
	 * sentence is about the service, and it falls back to the vendor only for a vendor that offers
	 * nothing on that seam at all.
	 */
	private notBuilt(vendor: CloudVendor, kind: 'objectStore' | 'logs'): string {
		const service = serviceFor(vendor, kind);
		const label = kind === 'objectStore'
			? objectStoreServices().find((entry) => entry.service === service)?.label
			: logSourceServices().find((entry) => entry.service === service)?.label;
		if (label) {
			return `${label} is not built yet.`;
		}
		const vendorLabel = cloudVendorInfo(vendor)?.label ?? vendor;
		return kind === 'objectStore'
			? `${vendorLabel} has no file storage this app can read.`
			: `${vendorLabel} has no log service this app can read.`;
	}

	/**
	 * Test the LOGS arm, by listing the scopes its picker lists.
	 *
	 * Regional, unlike a container listing, which is why it says so when there is no region to try.
	 */
	private async testLogs(form: CloudAccountForm): Promise<TestedService> {
		const driver = logSourceFor(form.account.vendor);
		if (!driver) {
			return { ok: false, label: '', message: this.notBuilt(form.account.vendor, 'logs') };
		}
		const label = driver.info.label;
		const region = form.account.region || driver.info.regions?.[0];
		if (!region) {
			return { ok: false, label, message: `Set a region first: ${label} lists its ${driver.info.scopeNoun}s one region at a time.` };
		}
		const scoped = { ...form.account, region };
		const session = driver.open(scoped, this.secretFrom(form));
		try {
			const scopes = await session.listScopes();
			const noun = driver.info.scopeNoun;
			return {
				ok: true,
				label,
				message: scopes.length === 0
					? `Connected to ${label} in ${region}. Nothing there yet.`
					: `Connected to ${label} in ${region}. ${scopes.length === 1 ? `One ${noun}` : `${scopes.length} ${noun}s`} visible.`,
				sample: scopes.slice(0, 3).map((scope) => scope.name),
			};
		} catch (err) {
			return { ok: false, label, message: driver.explain(err, scoped) };
		} finally {
			session.close();
		}
	}

	private withSecretFlag(account: CloudAccount): CloudAccountView {
		return { ...account, hasSecret: this.secretFor(account.id) !== undefined };
	}
}
