/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { objectStoreDriver } from './objectStore';
import { logSourceDriver } from './logSource';
import { discoverAwsProfiles, type AwsCredentialKind } from '../aws/config';
import {
	VENDOR_SERVICES,
	type CloudServiceKind,
	type CloudVendor,
	type CloudVendorInfo,
	type ImportableCredential,
} from '../../shared/cloud';

/*---------------------------------------------------------------------------------------------
 *  The VENDOR registry — what Settings offers, and what a picker asks whether an account can do.
 *
 *  This file exists because a credential belongs to a COMPANY and a driver belongs to a SERVICE,
 *  and those are two different lists. `objectStore.ts` and `logSource.ts` are the service seams;
 *  this is the one place that knows "an AWS account can be pointed at files and at log events",
 *  which is what makes adding a third service (RDS discovery on the same credential) a line in
 *  `VENDOR_SERVICES` plus a registry, and no change to any screen.
 *
 *  What is BUILT is computed rather than declared: a vendor's services are whichever seams answer
 *  with a driver right now. A hand-maintained second list is how a shipped build ends up offering
 *  something with nothing behind it, or hiding something that works.
 *
 *  Importing a credential from this computer is a VENDOR act, not a service one. It used to live on
 *  the S3 driver, so a CloudWatch account could not import anything at all while a second, unused
 *  copy of the same function sat in the CloudWatch driver. It is offered per vendor now, and both of
 *  a vendor's services get it.
 *--------------------------------------------------------------------------------------------*/

interface VendorDeclaration {
	label: string;
	what: string;
	importsFrom?: string;
	importable?: () => ImportableCredential[];
}

const VENDORS: Record<CloudVendor, VendorDeclaration> = {
	aws: {
		label: 'Amazon Web Services',
		what: 'Files in S3, log events in CloudWatch.',
		importsFrom: 'the AWS CLI',
		importable: importableAwsCredentials,
	},
	azure: {
		label: 'Microsoft Azure',
		what: 'Files in Blob Storage, log events in Azure Monitor.',
		importsFrom: 'the Azure CLI',
	},
	gcp: {
		label: 'Google Cloud',
		what: 'Files in Cloud Storage, log events in Cloud Logging.',
		importsFrom: 'the gcloud CLI',
	},
	s3compat: {
		label: 'S3-compatible storage',
		// Named rather than described, because this is the arm somebody arrives at by searching for
		// their vendor and it has to answer "is my thing here" without them knowing what S3 is.
		what: 'Cloudflare R2, MinIO, Backblaze B2, Wasabi, Ceph, or anything else that speaks the S3 API.',
		// The same file, and it is not a copy-paste: anyone driving MinIO or R2 from the `aws` CLI
		// keeps that key in a profile there and passes `--endpoint-url` beside it. What a profile
		// cannot do is tell us WHICH storage it is for, so the wording here says to pick the one
		// that holds this endpoint's key rather than implying we know.
		importsFrom: 'your AWS CLI config, where an S3-compatible key is usually kept',
		importable: importableAwsCredentials,
	},
};

/** The order Settings lists them in: what most people have, first. */
const ORDER: CloudVendor[] = ['aws', 'azure', 'gcp', 's3compat'];

/** Every vendor, with the services this build can actually do for it. */
export function cloudVendors(): CloudVendorInfo[] {
	return ORDER.map((vendor) => ({
		vendor,
		label: VENDORS[vendor].label,
		what: VENDORS[vendor].what,
		importsFrom: VENDORS[vendor].importsFrom,
		services: builtServices(vendor),
	}));
}

export function cloudVendorInfo(vendor: CloudVendor): CloudVendorInfo | undefined {
	return cloudVendors().find((entry) => entry.vendor === vendor);
}

/**
 * The seams that have a driver for this vendor right now.
 *
 * Asked of the registries rather than declared, so an unbuilt service is unbuilt everywhere at
 * once and a picker's "not built yet" is the same fact the runner would hit.
 */
export function builtServices(vendor: CloudVendor): CloudServiceKind[] {
	const services = VENDOR_SERVICES[vendor];
	const built: CloudServiceKind[] = [];
	if (services?.objectStore && objectStoreDriver(services.objectStore)) {
		built.push('objectStore');
	}
	if (services?.logs && logSourceDriver(services.logs)) {
		built.push('logs');
	}
	return built;
}

/**
 * Credentials this computer already has that a vendor can adopt WITHOUT copying a secret.
 *
 * Read-only and secret-free by construction: what is produced NAMES a local credential, never one
 * that carries it. Empty for a vendor whose importer is not written yet, which a screen states
 * rather than hides.
 */
export function importableFor(vendor: CloudVendor): ImportableCredential[] {
	return VENDORS[vendor]?.importable?.() ?? [];
}

/** One AWS CLI profile as the shared, vendor-neutral shape. Nothing of theirs is copied. */
function importableAwsCredentials(): ImportableCredential[] {
	return discoverAwsProfiles().map((profile) => ({
		id: profile.name,
		label: profile.name,
		region: profile.region,
		kind: KIND_LABEL[profile.kind],
		note: profile.note,
		// A NAME, never a copied key. The SDK resolves it at call time exactly as `aws` does, so it
		// stays where its owner manages it and keeps working when they rotate it.
		auth: { mode: 'named' as const, name: profile.name },
	}));
}

const KIND_LABEL: Record<AwsCredentialKind, string> = {
	key: 'An access key',
	sso: 'Signed in through SSO',
	role: 'Assumes a role',
	process: 'Runs a command to fetch credentials',
	webIdentity: 'Uses a web identity token',
	unknown: 'No credentials of its own',
};
