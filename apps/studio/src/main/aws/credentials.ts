/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromIni } from '@aws-sdk/credential-providers';

/**
 * How this app proves who it is to AWS, in one place.
 *
 * Extracted from `awsSecrets.ts` (where it served a connection whose password comes from Secrets
 * Manager) so cloud storage answers the question the same way. A user who has set one of these up
 * for a database has set it up for a bucket, and two resolvers would be two chances to disagree
 * about which credential wins.
 *
 * The precedence is unchanged and is the SDK's own convention: an explicit key pair, then a named
 * profile from the shared config, then the default provider chain (environment variables, SSO, an
 * EC2/ECS/EKS role). Returning `{}` for the last one is deliberate — handing the client nothing is
 * what makes it use its own chain, and inventing a provider here would take that away.
 */
export interface AwsAuthFields {
	/** The access key id. The SECRET never lives on a config object; it arrives separately. */
	accessKeyId?: string;
	/** A named profile from the shared AWS config/credentials file. */
	profile?: string;
}

/** The `credentials` half of an AWS client's constructor arguments, or `{}` for the default chain. */
export function awsCredentials(auth: AwsAuthFields, secretAccessKey: string | undefined) {
	if (auth.accessKeyId && secretAccessKey) {
		return { credentials: { accessKeyId: auth.accessKeyId, secretAccessKey } };
	}
	if (auth.profile) {
		return { credentials: fromIni({ profile: auth.profile }) };
	}
	return {};
}
