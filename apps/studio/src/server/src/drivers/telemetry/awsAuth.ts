/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  How the SERVER child proves who it is to AWS.
 *
 *  A deliberate second copy of `src/main/aws/credentials.ts`, not an oversight and not shared: main
 *  and the language-server child are separate processes built into separate bundles, and neither
 *  may import the other's tree. `src/shared` cannot hold it either — every file there is pure, and
 *  this one requires an SDK. The same reasoning `logSource.ts` records for `explainCloudWatchLogs`
 *  needing its own copy.
 *
 *  The PRECEDENCE must not drift from main's, because a user who set a credential up for a flow
 *  expects the same one to serve a connection: an explicit key pair, then a named profile from the
 *  shared AWS config, then the SDK's own default chain (environment, SSO, an instance role).
 *  Returning `{}` for the last is what hands the client its chain; inventing a provider would take
 *  that away.
 *
 *  WHERE EACH MODE RESOLVES. An explicit key arrives here already resolved by main out of the
 *  keychain (the DB-password rule: secrets are resolved in main, the server sees them resolved). A
 *  named profile and the default chain resolve HERE, in the child, because what they read is files
 *  on the user's disk and an SSO token that refreshes — copying either into a message would ship a
 *  snapshot that goes stale the moment it is rotated.
 *--------------------------------------------------------------------------------------------*/

import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types';

import type { CloudAccount } from '../../../../shared/cloud';

/** `@aws-sdk/credential-providers`, required lazily: the server child must not pay for an SDK at
 *  load time for a connection the user may never open. */
function credentialProviders(): typeof import('@aws-sdk/credential-providers') {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('@aws-sdk/credential-providers') as typeof import('@aws-sdk/credential-providers');
}

/** The `credentials` half of an AWS client's constructor arguments, or `{}` for the default chain. */
export function awsCredentialsFor(
	account: CloudAccount,
	secret: string | undefined,
): { credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider } {
	if (account.auth.mode === 'key' && account.auth.keyId && secret) {
		return { credentials: { accessKeyId: account.auth.keyId, secretAccessKey: secret } };
	}
	if (account.auth.mode === 'named') {
		return { credentials: credentialProviders().fromIni({ profile: account.auth.name }) };
	}
	return {};
}
