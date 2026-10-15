/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A SIGNED Windows build: electron-builder.yml plus Azure Trusted Signing, with the signing account
// taken from the environment so no account name lives in the source. Used by the release jobs:
//   npx electron-builder --config electron-builder.win-signing.cjs --win ...
// They set AZURE_SIGNING_ACCOUNT and AZURE_SIGNING_PROFILE (and, optionally, AZURE_SIGNING_ENDPOINT),
// plus the AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET that electron-builder signs with.
// A build without this file is unsigned and needs none of them.
//
// publisherName is intentionally NOT set: the TrustedSigning PowerShell module electron-builder
// installs dropped the -publisherName parameter, so passing it fails the sign step; the module
// derives the publisher from the certificate profile. (electron-builder 26's validator requires it,
// so moving off 25.1.8 means bringing it back AND pinning a module version that still accepts it.)
//
// Azure Trusted Signing issues a SHORT-LIVED certificate (about three days). Without an RFC 3161
// countersignature timestamp the signature turns invalid when that certificate expires, and Windows
// shows "Unknown publisher" to everyone who downloads later. electron-builder forwards only the keys
// given here to Invoke-TrustedSigning, verbatim as PowerShell parameters (hence the PascalCase), and
// adds no timestamp by default, so the timestamp service is named explicitly.

function required(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is not set: a signed Windows build needs the Azure Trusted Signing account (see the header of electron-builder.win-signing.cjs)`);
	}
	return value;
}

module.exports = {
	extends: './electron-builder.yml',
	win: {
		azureSignOptions: {
			endpoint: process.env.AZURE_SIGNING_ENDPOINT || 'https://eus.codesigning.azure.net/',
			codeSigningAccountName: required('AZURE_SIGNING_ACCOUNT'),
			certificateProfileName: required('AZURE_SIGNING_PROFILE'),
			TimestampRfc3161: 'http://timestamp.acs.microsoft.com',
			TimestampDigest: 'SHA256',
		},
	},
};
