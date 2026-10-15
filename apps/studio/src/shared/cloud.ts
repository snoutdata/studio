/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Cloud accounts — a saved CREDENTIAL, referenced by id wherever it is used, and the vocabulary
 *  every vendor and every service shares.
 *
 *  Five decisions shape this file, and the first two are the ones that stop it being rewritten when
 *  the next service lands.
 *
 *  1. AN ACCOUNT IS A VENDOR, NOT A SERVICE. What the user sets up once is "who we are to AWS".
 *     WHICH SERVICE of that vendor is used - files in S3, events in CloudWatch - is named by what
 *     uses the account (a telemetry connection names its service), never by the account. An
 *     account per SERVICE would make Settings offer one form per service and need a new one for
 *     every service added. Adding a service must not mean touching Settings.
 *
 *  2. A SERVICE IS A DRIVER. S3, Azure Blob and GCS differ in their SDK, their error vocabulary and
 *     what they call things - and in nothing else this app cares about. So the types here are the
 *     shared shape and `main/cloud/objectStore.ts` (files) and `main/cloud/logSource.ts` (events)
 *     are the seams; nothing outside a driver names a vendor. This is the same split
 *     `DatabaseDriver` and `ModelProvider` already make. A third seam - RDS discovery on the same
 *     AWS credential, say - is one more entry in {@link VENDOR_SERVICES} and one more registry,
 *     and no change here or in Settings.
 *
 *  3. AN ACCOUNT IS NOT A CONTAINER. What is saved is the credential. WHICH BUCKET or WHICH LOG
 *     GROUP is meant is chosen where the account is used, from a list fetched with it, because an
 *     account may have forty of them. Settings that asked for a bucket name would be asking for
 *     something the account already knows.
 *
 *  4. AN ACCOUNT IS NOT A CONNECTION EITHER. `ConnectionConfig` is host / port / database / driver /
 *     pool / schema-cache shaped, and storage expressed as one would turn up in the connections
 *     tree, the schema explorer, the SQL editor's picker and the MCP broker, in none of which it
 *     means anything. This follows `SshTunnelProfile`: a small named profile in its own file,
 *     referenced by id, secret in the keychain. If connections ever get a shared profile
 *     (`ConnectionProfile` + `AuthScheme`), this folds into it.
 *
 *  5. NO SECRET IS IN HERE. The file is written to userData in the clear, exactly as
 *     `connections.json` and `tunnels.json` are, so a secret lives in `secretStore` under
 *     {@link cloudSecretId} and nothing on this type can hold one.
 *--------------------------------------------------------------------------------------------*/

/**
 * Whose credential an account holds.
 *
 * The axis the user thinks in and the axis Settings is organised by: one entry for AWS, whatever
 * that account is later pointed at.
 *
 * `s3compat` is the one arm that is not a company, and it is here rather than folded into `aws`
 * because R2, MinIO, Backblaze B2, Wasabi and Ceph speak the S3 API and can never do CloudWatch.
 * Calling them AWS would be false, and giving each its own arm would be six copies of one driver
 * differing in a URL - {@link CloudAccount.endpoint} is what tells them apart, and the source
 * catalogue lists them by name so nobody has to know that.
 */
export type CloudVendor = 'aws' | 'azure' | 'gcp' | 's3compat';

/**
 * One service of one vendor: a driver's identity, never an account's.
 *
 * An arm here means a genuinely different API. S3-compatible services are NOT arms of this: they
 * are `s3`, reached with an endpoint set, which is why `s3` names an API dialect and `aws` names
 * the company.
 */
export type CloudServiceId = 's3' | 'azureBlob' | 'gcs' | 'cloudwatch' | 'azureMonitor' | 'gcpLogging';

/** The services that hold FILES, and therefore the only ones an object-store picker may offer. */
export type ObjectStoreServiceId = Extract<CloudServiceId, 's3' | 'azureBlob' | 'gcs'>;

/**
 * The services that hold LOG EVENTS.
 *
 * Almost every cloud has one of these and they are the same shape: a scope you name, events with a
 * producer clock, a service clock and an id. AWS CloudWatch Logs is the first driver; Azure Monitor
 * (Log Analytics) and GCP Cloud Logging are declared here so a picker can list them and decline
 * honestly rather than leave an arm nobody has thought about.
 */
export type LogServiceId = Extract<CloudServiceId, 'cloudwatch' | 'azureMonitor' | 'gcpLogging'>;

/** Which SEAM a service plugs into: one registry, one driver interface, one flow source arm. */
export type CloudServiceKind = 'objectStore' | 'logs';

/**
 * What each vendor offers on each seam. The one place a new service is declared.
 *
 * Pure and shared on purpose: the renderer needs it to know that an AWS account can serve a log
 * source, and main needs it to find a driver. Whether that service is BUILT is a separate question,
 * answered by {@link CloudVendorInfo.services}, because only main holds the registries.
 */
export const VENDOR_SERVICES: Readonly<Record<CloudVendor, Readonly<{ objectStore?: ObjectStoreServiceId; logs?: LogServiceId }>>> = {
	aws: { objectStore: 's3', logs: 'cloudwatch' },
	azure: { objectStore: 'azureBlob', logs: 'azureMonitor' },
	gcp: { objectStore: 'gcs', logs: 'gcpLogging' },
	// Storage only, and that is the whole reason this vendor exists rather than being an AWS flag.
	s3compat: { objectStore: 's3' },
};

/** The service id a vendor uses on one seam, or undefined when it has nothing there. */
export function serviceFor(vendor: CloudVendor, kind: CloudServiceKind): CloudServiceId | undefined {
	return kind === 'objectStore' ? VENDOR_SERVICES[vendor]?.objectStore : VENDOR_SERVICES[vendor]?.logs;
}

/** What a vendor is called, and which of its services this build can actually do. */
export interface CloudVendorInfo {
	vendor: CloudVendor;
	/** "Amazon Web Services", "S3-compatible storage". */
	label: string;
	/**
	 * The seams that have a driver for this vendor TODAY.
	 *
	 * What every picker filters on: an account is offered to the bucket step when this holds
	 * `objectStore`. Empty means the vendor is declared and nothing of it is built, and a picker
	 * says so rather than hiding it - an arm that is invisible is indistinguishable from one nobody
	 * has thought about.
	 */
	services: CloudServiceKind[];
	/** Where its importable credentials come from, e.g. "the AWS CLI". Absent when it has none. */
	importsFrom?: string;
	/** One line naming what an account here can be pointed at, for the vendor picker. */
	what: string;
}

/**
 * How the app proves who it is to the storage.
 *
 * Three shapes, and they are the three every one of these clouds actually has, which is why this is
 * shared rather than per-provider. The DRIVER decides what each means:
 *
 * | | S3 | Azure Blob | GCS |
 * |---|---|---|---|
 * | `key`   | access key id + secret | account name + account key | HMAC key |
 * | `named` | an AWS CLI profile | an `az` CLI account | a `gcloud` configuration |
 * | `chain` | env / SSO / instance role | `DefaultAzureCredential` | application default credentials |
 */
export type CloudAuth =
	/**
	 * A key pair. The public half is on this object; the SECRET is in the keychain under
	 * {@link cloudSecretId} and is never part of an account.
	 */
	| { mode: 'key'; keyId: string }
	/**
	 * A credential this computer already has, adopted by NAME — what "import from the CLI"
	 * produces. Nothing of theirs is copied: the SDK resolves it at call time, so it stays where its
	 * owner manages it and keeps working when they rotate it.
	 */
	| { mode: 'named'; name: string }
	/** Whatever the environment already provides. Nothing is stored. */
	| { mode: 'chain' }
	/**
	 * A whole credential DOCUMENT, held in the keychain under {@link cloudSecretId}.
	 *
	 * The fourth mode exists because Google's service account is not a key PAIR: it is a JSON file
	 * holding a project id, a client email and a private key, issued as one artifact and rotated as
	 * one artifact. Splitting it into `keyId` + secret would mean parsing somebody's credential to
	 * store it and reassembling it to use it, and getting that wrong is an authentication failure
	 * nobody can debug from the outside.
	 *
	 * Nothing of the document is on this object — `label` is only what to show in a list, and the
	 * driver reads the document itself from the keychain. Azure's account key fits `key` (an account
	 * NAME plus a secret) and does not need this.
	 */
	| { mode: 'document'; label: string };

/** A cloud account the user has named once and can use in any number of places. */
export interface CloudAccount {
	/** Stable id. What uses the account references it by this, and it is the keychain key. */
	id: string;
	/** What the user calls it in a picker, e.g. "acme production". */
	name: string;
	/**
	 * Whose credential this is. NOT which service it is for: that is named by what uses it, from
	 * {@link VENDOR_SERVICES}, which is what lets a service be added without touching Settings.
	 */
	vendor: CloudVendor;
	/**
	 * The region to talk to by default.
	 *
	 * Optional, and a starting point rather than a constraint: listing containers is account-wide
	 * and needs no correct region, and a container carries its own (see {@link CloudContainer}),
	 * which is the one used. A wrong one here therefore costs nothing.
	 */
	region?: string;
	/**
	 * A non-default endpoint, for anything that speaks the provider's API somewhere else (R2, MinIO,
	 * Backblaze, Wasabi, Ceph; Azurite for Azure). Absent means the vendor's own.
	 */
	endpoint?: string;
	/**
	 * The Azure directory (tenant) the credential belongs to.
	 *
	 * Azure-only, and it is here rather than folded into {@link CloudAuth} because it is a fact
	 * about WHERE the account lives, not about how it proves itself: the same tenant serves a
	 * client secret, an `az` session and a managed identity alike.
	 *
	 * Blob storage never needed it — an account key addresses one storage account and carries its
	 * own scope — but AAD does: a client id and secret cannot be exchanged for a token without the
	 * directory to exchange them at. Optional, so an account that signs in through the Azure CLI or
	 * the ambient chain (which discover their own tenant) never has to supply one.
	 */
	tenantId?: string;
	/**
	 * Address containers by path (`endpoint/bucket/key`) rather than by host
	 * (`bucket.endpoint/key`).
	 *
	 * A genuine behaviour switch rather than a preference: host addressing against a server that
	 * does not do it fails as a DNS error, which reads as "your network is broken" and is not.
	 */
	forcePathStyle?: boolean;
	auth: CloudAuth;
}

/** Keychain id under which an account's secret is stored. Mirrors `tunnelSecretId`. */
export function cloudSecretId(accountId: string): string {
	return `cloud:${accountId}`;
}

/**
 * A credential already on this computer that a provider can adopt WITHOUT copying a secret.
 *
 * The generic form of "import from the AWS CLI", and it is generic because the other two clouds
 * have exactly the same thing: `az account list`, `gcloud config configurations list`. A driver
 * produces these; the page renders them; adopting one yields {@link auth}.
 */
export interface ImportableCredential {
	/** Unique within the provider, e.g. an AWS profile name. */
	id: string;
	/** What to show. Usually the id, and not always. */
	label: string;
	/** Filled into the account when this is adopted, when the source states one. */
	region?: string;
	/** What kind it is, in the provider's own words ("An access key", "Signed in through SSO"). */
	kind: string;
	/**
	 * What this kind means when nobody is at the computer to sign in again, when it means anything:
	 * an SSO sign-in expires, a key does not. Shown beside the credential when it is offered.
	 */
	note?: string;
	/** What adopting this becomes. */
	auth: CloudAuth;
}

/**
 * A container an account can see: a bucket on S3 and GCS, a container on Azure.
 *
 * Called a container in the code and by the driver's own noun on screen
 * ({@link ObjectStoreInfo.containerNoun}), because "bucket" is two vendors' word out of three and
 * a shared type may not pick a side.
 */
export interface CloudContainer {
	name: string;
	/**
	 * Its own region, where the provider reports one.
	 *
	 * The field that makes a picker worth having: a container addressed in the wrong region answers
	 * with a redirect, which reads as nothing at all, and is the commonest way one of these setups
	 * fails silently. Absent when the credentials can list it but not locate it.
	 */
	region?: string;
}

/** One object as a listing reports it: everything the freshness rule needs, and nothing fetched. */
export interface CloudObject {
	/** The full key, including any prefix. Unique within the container, and the item's IDENTITY. */
	key: string;
	size: number;
	/** ISO. The storage's clock, which is why it is a first-run floor and never the change signal. */
	lastModified?: string;
	/**
	 * The storage's own content fingerprint: an S3 ETag, an Azure ETag or `Content-MD5`, a GCS
	 * generation. Quoting is stripped on the way in.
	 *
	 * This is what "changed" means, and the reason it is not `lastModified`:
	 * a date moves when identical bytes are re-uploaded, and a date compared against a run's own
	 * clock silently SKIPS an object written while the run was in flight.
	 */
	etag?: string;
}

/** What a listing hands back. Paged, because a container may hold millions. */
export interface CloudListing {
	objects: CloudObject[];
	/** Pass back as `after` to continue. Absent when the listing is complete. */
	next?: string;
	/** True when the page cap stopped it, so a caller can say so rather than imply completeness. */
	truncated: boolean;
}

/** What a storage SERVICE is called and what it calls things, so copy never hardcodes a noun. */
export interface ObjectStoreInfo {
	service: ObjectStoreServiceId;
	/** "Amazon S3", "Azure Blob Storage". */
	label: string;
	/** "bucket", "container". Lower case; the UI capitalises where it needs to. */
	containerNoun: string;
	/** False for an arm that is declared and has no driver yet, so the UI can decline honestly. */
	built: boolean;
	/** Where its importable credentials come from, e.g. "the AWS CLI". Absent when it has none. */
	importsFrom?: string;
}

/**
 * An account as it arrives from the renderer: the saved fields, plus a secret to store this once.
 *
 * Here rather than beside the service that consumes it, because preload and the renderer may not
 * import a main-side type.
 */
export interface CloudAccountForm {
	account: CloudAccount;
	/**
	 * The secret, when the user has just typed one.
	 *
	 * Three states, and they are three different intentions: a string stores it, `null` DELETES the
	 * stored one (the user cleared the field), and `undefined` leaves whatever is there alone (the
	 * user renamed the account and never touched the key). Collapsing the last two would wipe a
	 * working credential every time somebody edited a name.
	 */
	secret?: string | null;
}

/**
 * An account as the renderer sees it: never the secret, only whether there is one.
 *
 * The split is the whole IPC rule for this feature. Nothing returns a stored secret, so there is no
 * handler to get wrong later; `hasSecret` is what a page needs in order to offer Remove without
 * round-tripping the value. Same shape as `learn:hasToken`, for the same reason.
 */
export interface CloudAccountView extends CloudAccount {
	hasSecret: boolean;
}

/**
 * Every container an account can see. Reports rather than throws, like every other answer here:
 * "these credentials cannot list containers" is a normal state with a normal sentence.
 */
export interface CloudContainerList {
	ok: boolean;
	containers: CloudContainer[];
	/** Present when it did not work. */
	message?: string;
}

/**
 * What "can this app reach this account" answers.
 *
 * It is a container listing, which is the same call the picker makes — so a green tick is not a
 * claim about permissions in general, it is the exact thing the next screen needs working.
 */
export interface CloudTestResult {
	ok: boolean;
	/** One sentence, in the user's terms, whether it worked or not. */
	message: string;
	/** A few container names, when it worked: proof it reached the right account rather than merely
	 *  authenticating against some account. */
	sample?: string[];
}

/*---------------------------------------------------------------------------------------------
 *  Log events.
 *
 *  The second thing a cloud account is for. Deliberately in this file rather than a new one: these
 *  are the same shared vocabulary as {@link CloudContainer} and {@link CloudObject}, one layer down
 *  from a driver, and splitting them would mean two files describing one credential.
 *--------------------------------------------------------------------------------------------*/

/**
 * One named place events live: a CloudWatch **log group**, an Azure Monitor **table**, a GCP
 * Cloud Logging **log**.
 *
 * Called a SCOPE in the code and by the driver's own noun on screen
 * ({@link LogServiceInfo.scopeNoun}), for the same reason {@link CloudContainer} is not called a
 * bucket: "log group" is one vendor's word and a shared type may not pick a side.
 */
export interface LogScope {
	name: string;
	/**
	 * Bytes the provider says it holds, where it reports one.
	 *
	 * The field that turns "read the last 12 months" from a shrug into a decision: 18 GB and 172 GB
	 * look identical in a dropdown and are completely different asks. Shown beside the name.
	 */
	storedBytes?: number;
	/** Days the provider keeps events for, where one is set. Absent means it keeps them forever,
	 *  which is a fact about how much history a starting point can actually reach. */
	retentionDays?: number;
}

/** Every scope an account can see. Reports rather than throws, like {@link CloudContainerList}. */
export interface LogScopeList {
	ok: boolean;
	scopes: LogScope[];
	/** Present when it did not work. */
	message?: string;
}

/**
 * What a log provider is called and what it calls things, so copy never hardcodes a vendor's noun.
 *
 * The sibling of {@link ObjectStoreInfo}, and separate from it because the nouns are different:
 * storage has containers, logs have scopes and streams and a query language of their own.
 */
export interface LogServiceInfo {
	service: LogServiceId;
	/** "Amazon CloudWatch Logs", "Azure Monitor Logs", "Google Cloud Logging". */
	label: string;
	/** "log group", "table", "log". Lower case; the UI capitalises where it needs to. */
	scopeNoun: string;
	/** False for an arm that is declared and has no driver yet, so the UI can decline honestly. */
	built: boolean;
	/** Where its importable credentials come from, e.g. "the AWS CLI". Absent when it has none. */
	importsFrom?: string;
	/**
	 * What the provider calls the sub-division of a scope, where it has one.
	 *
	 * CloudWatch has log streams; Azure Monitor and GCP Cloud Logging have nothing of the kind.
	 * Absent means the wizard does not ask, rather than asking for something that does not exist.
	 */
	streamNoun?: string;
	/**
	 * What the provider calls its own filter language, e.g. "filter pattern", "KQL", "log filter".
	 *
	 * The text is passed through untouched — we do not parse or translate someone's query language,
	 * and the wizard says whose it is so a user knows which documentation to reach for.
	 */
	filterLabel?: string;
	/** One example in that language, shown as the field's placeholder. */
	filterExample?: string;
	/**
	 * Where this provider has scopes, so the wizard offers a list rather than a text box.
	 *
	 * On the seam and not in the UI because only a driver knows its own vendor's regions, and a
	 * generic picker that hardcoded one vendor's list is exactly what `scopeNoun` exists to prevent.
	 * Absent means the wizard asks for one in a field, which is the honest fallback.
	 */
	regions?: string[];
}

/**
 * One log event, reduced to what this app needs and nothing vendor-shaped.
 *
 * TWO CLOCKS, kept apart: {@link at} is the producer's own timestamp and is what a time window is
 * bounded by, while {@link ingestedAt} is when the service actually had it. Every one of these
 * clouds has both: CloudWatch's `timestamp`/`ingestionTime`, GCP Cloud Logging's
 * `timestamp`/`receiveTimestamp`, Azure Monitor's `TimeGenerated` against its ingestion latency.
 */
export interface LogEvent {
	/**
	 * Unique per event. The item's IDENTITY, exactly as a key is for an object.
	 *
	 * Every provider that matters has one (CloudWatch's `eventId`, GCP's `insertId`). A driver whose
	 * API does NOT is expected to synthesize a stable one from what it does have, and to say so in
	 * its own file — a synthesized id that is not stable across two reads of the same event turns
	 * the boundary dedupe into a no-op, which fails as duplicates rather than as an error.
	 */
	id: string;
	/** Producer clock, ms since epoch. */
	at: number;
	/** Service clock, ms since epoch, where the provider reports one. */
	ingestedAt?: number;
	/** The stream within the group, where the provider has such a thing. */
	stream?: string;
	message: string;
}

/*---------------------------------------------------------------------------------------------
 *  Telemetry CONNECTIONS — the log services as query-able backends.
 *
 *  A log service serves two different things in this app and they must not be conflated: a flow
 *  SOURCE (it streams events into a sink, `LogServiceInfo` above) and a CONNECTION (its scopes are
 *  tables and SQL runs against them, described here). One account, one vendor, two uses.
 *
 *  This descriptor is here rather than beside the driver because THREE processes need it and only
 *  one of them can hold a driver: the renderer labels the connection form's fields with it, main
 *  validates against it, and the server child's plugins are it. Pure data, so all three can.
 *--------------------------------------------------------------------------------------------*/

/**
 * The AWS regions a log group can live in.
 *
 * Written down rather than fetched: `DescribeRegions` is an EC2 call needing its own permission, so
 * a user whose policy allows `logs:*` and nothing else would get an empty list and no way to choose
 * one. Every field that offers these also accepts a typed value, so a few months of staleness costs
 * nothing; what it buys is that nobody has to remember whether it is `eu-west-1` or `eu-west1`.
 */
export const AWS_REGIONS: readonly string[] = [
	'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
	'af-south-1',
	'ap-east-1', 'ap-south-1', 'ap-south-2',
	'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
	'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
	'ca-central-1', 'ca-west-1',
	'eu-central-1', 'eu-central-2',
	'eu-west-1', 'eu-west-2', 'eu-west-3',
	'eu-north-1', 'eu-south-1', 'eu-south-2',
	'il-central-1',
	'me-central-1', 'me-south-1',
	'sa-east-1',
];

/** What a telemetry service is called, what it calls its parts, and what a connection to it needs. */
export interface TelemetryServiceDescriptor {
	/** The service id, which is ALSO the connection's driver id — a connection is pointed at a
	 *  service, and the account it uses is the vendor's. */
	service: LogServiceId;
	label: string;
	/** The vendor whose {@link CloudAccount} authenticates it. A connection whose account is some
	 *  other vendor is refused at connect, by name. */
	vendor: CloudVendor;
	/** "log group", "table", "log". Lower case; the UI capitalises where it needs to. */
	scopeNoun: string;
	/**
	 * What the CONTAINER a connection is scoped to is called: an AWS region, an Azure Log Analytics
	 * workspace, a GCP project. One connection is one container, which is why this is a field on the
	 * connection and not a picker inside it.
	 */
	containerNoun: string;
	/** An example value, as the field's placeholder. */
	containerExample: string;
	/** Offered as a list where the closed set is knowable. Absent means the form asks for it in a
	 *  plain field, which is the honest fallback for a GUID or a project id. */
	containerOptions?: readonly string[];
	/** What this provider's own query language is called, for the native surface. Absent when it
	 *  has none worth authoring in. */
	nativeLanguage?: string;
	/**
	 * True when the service can GROUP BY at the source.
	 *
	 * False does not mean grouping is unavailable — the app computes it over a completed scan
	 * instead — it means grouping there is bounded by what a scan can read, and the UI says so
	 * rather than letting a `count(*)` fail at an unexplained cap.
	 */
	aggregatesAtSource: boolean;
}

/** Every telemetry service, keyed by the driver id a connection carries. */
export const TELEMETRY_SERVICES: Readonly<Record<LogServiceId, TelemetryServiceDescriptor>> = {
	cloudwatch: {
		service: 'cloudwatch',
		label: 'Amazon CloudWatch Logs',
		vendor: 'aws',
		scopeNoun: 'log group',
		containerNoun: 'region',
		containerExample: 'eu-west-1',
		containerOptions: AWS_REGIONS,
		nativeLanguage: 'CloudWatch Logs Insights',
		aggregatesAtSource: true,
	},
	azureMonitor: {
		service: 'azureMonitor',
		label: 'Azure Monitor Logs',
		vendor: 'azure',
		scopeNoun: 'table',
		containerNoun: 'workspace ID',
		// The workspace ID (a GUID), not its resource name: it is what the query API addresses.
		containerExample: '00000000-0000-0000-0000-000000000000',
		nativeLanguage: 'KQL',
		aggregatesAtSource: true,
	},
	gcpLogging: {
		service: 'gcpLogging',
		label: 'Google Cloud Logging',
		vendor: 'gcp',
		scopeNoun: 'log',
		containerNoun: 'project',
		containerExample: 'my-project-id',
		nativeLanguage: 'a Cloud Logging filter',
		// The Logging API lists entries and cannot summarise, at any price.
		aggregatesAtSource: false,
	},
};

/** The descriptor for a driver id, or undefined when it is not a telemetry backend. The single
 *  question every caller asks — "is this connection a log service, and which". */
export function telemetryServiceFor(driverId: string | undefined): TelemetryServiceDescriptor | undefined {
	return driverId ? TELEMETRY_SERVICES[driverId as LogServiceId] : undefined;
}
