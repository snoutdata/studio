/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VENDOR_SERVICES } from '../../shared/cloud';
import type {
	CloudAccount,
	CloudContainer,
	CloudListing,
	CloudVendor,
	ObjectStoreInfo,
	ObjectStoreServiceId,
} from '../../shared/cloud';

/*---------------------------------------------------------------------------------------------
 *  The pluggable contract every object-storage backend implements.
 *
 *  Modelled on `DatabaseDriver` + `driverRegistry` deliberately, down to the factory map and the
 *  "new vendors are added in one function" rule, because it is the same problem: several vendors,
 *  one set of operations, and feature code that must never special-case one. S3 is the only shipped
 *  driver; Azure Blob and GCS register against this same interface, and nothing outside a driver
 *  names a vendor.
 *
 *  The one deliberate difference from `DatabaseDriver`: a session here is a CLIENT, not a
 *  connection. There is no `connect`/`isConnected`/`ping` because none of these APIs has a session
 *  to keep alive — `open` builds a signing client and costs nothing, and `close` releases sockets.
 *  Giving it a connection lifecycle it does not have would be a lie the whole app then works around.
 *--------------------------------------------------------------------------------------------*/

/** What one object read wants to know while it happens. */
export interface DownloadOptions {
	signal?: AbortSignal;
	onProgress?: (bytes: number) => void;
}

export interface ListOptions {
	/** The container's OWN region, when the caller knows it from a listing. A driver that addresses
	 *  a container in the wrong region gets a redirect the user cannot read. */
	region?: string;
	/**
	 * Matched as a literal STRING, never as a directory: `exports` also selects
	 * `exports-old/2024.csv` and `exports/` does not. A driver must pass it through exactly as
	 * given — normalising a separator would quietly change which objects a saved flow reads.
	 */
	prefix?: string;
	/** A previous page's `next`. */
	after?: string;
	max?: number;
	signal?: AbortSignal;
}

/** An open client for one account. Cheap to make, and closed by whoever opened it. */
export interface ObjectStoreSession {
	/** Every container these credentials can see, with each one's region where the API reports it. */
	listContainers(signal?: AbortSignal): Promise<CloudContainer[]>;

	/** One page of objects. Transfers no object bytes: this is what the freshness rule reads. */
	list(container: string, options?: ListOptions): Promise<CloudListing>;

	/**
	 * The first `bytes` of one object, so `classifyContent` can say what it is without downloading
	 * it. That function is pure and byte-based, which is what makes this the cheap path and is the
	 * whole reason a driver exposes a ranged read rather than only a whole one.
	 */
	head(container: string, key: string, bytes: number, signal?: AbortSignal): Promise<Buffer>;

	/** Stream one object to a local file. The caller owns the file, including deleting it. */
	download(container: string, key: string, destination: string, options?: DownloadOptions): Promise<number>;

	/** Release sockets. Safe to call twice. */
	close(): void;
}

export interface ObjectStoreDriver {
	readonly info: ObjectStoreInfo;

	/** Build a client. Nothing is fetched and nothing is validated: this is not a connect. */
	open(account: CloudAccount, secret: string | undefined): ObjectStoreSession;

	/**
	 * A failure as a sentence that names the fix, in this provider's own error vocabulary.
	 *
	 * The same discipline as `reachFailure.ts`, and the reason it belongs to the driver: an SDK
	 * reports a class name and a request id, and the ways this goes wrong are indistinguishable to
	 * a user unless we say which one it was — in words that are true of THIS vendor.
	 */
	explain(err: unknown, account: CloudAccount, container?: string): string;
}

export type ObjectStoreDriverFactory = () => ObjectStoreDriver;

const factories = new Map<ObjectStoreServiceId, ObjectStoreDriverFactory>();

export function registerObjectStoreDriver(service: ObjectStoreServiceId, factory: ObjectStoreDriverFactory): void {
	factories.set(service, factory);
}

/**
 * The driver for a service, or undefined for an arm that is declared and not built.
 *
 * Undefined rather than a throw, on purpose: "we know what this is and cannot do it yet" is a
 * first-class answer everywhere in this feature family, and a screen that can ask this question can
 * decline honestly instead of showing an error.
 */
export function objectStoreDriver(service: string): ObjectStoreDriver | undefined {
	// Takes a plain string rather than the narrowed union on purpose: a caller may hold a service
	// id from anywhere. "That is not one of mine" is a normal answer here, not a type error to be
	// cast away at every call site.
	return factories.get(service as ObjectStoreServiceId)?.();
}

/**
 * The driver that serves this VENDOR's files, or undefined when it has none or it is not built.
 *
 * The lookup every caller above the seam uses, because what they hold is an ACCOUNT and an account
 * names a vendor. The service id in between is the driver's business.
 */
export function objectStoreFor(vendor: CloudVendor): ObjectStoreDriver | undefined {
	const service = VENDOR_SERVICES[vendor]?.objectStore;
	return service ? objectStoreDriver(service) : undefined;
}

/** Every storage service, built or not, so a picker can list them and grey out what has no driver. */
export function objectStoreServices(): ObjectStoreInfo[] {
	return ALL_SERVICES.map((service) => objectStoreDriver(service)?.info ?? UNBUILT[service]);
}

/** Declared arms, in the order a picker shows them. */
const ALL_SERVICES: ObjectStoreServiceId[] = ['s3', 'azureBlob', 'gcs'];

/**
 * What a service with no driver is called.
 *
 * Written down rather than derived, so a user is told "Azure Blob Storage is not built yet" instead
 * of seeing an arm that silently does not appear. An arm that is invisible is indistinguishable
 * from one nobody has thought about.
 */
const UNBUILT: Record<ObjectStoreServiceId, ObjectStoreInfo> = {
	s3: { service: 's3', label: 'Amazon S3', containerNoun: 'bucket', built: false },
	azureBlob: { service: 'azureBlob', label: 'Azure Blob Storage', containerNoun: 'container', built: false },
	gcs: { service: 'gcs', label: 'Google Cloud Storage', containerNoun: 'bucket', built: false },
};
