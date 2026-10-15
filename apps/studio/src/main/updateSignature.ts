/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Who a Windows update must be signed by. Pure, so it is tested without Electron.
//
// electron-builder writes the same list into the packaged app-update.yml (the publish block's
// `publisherName` in electron-builder.yml), and electron-updater checks a fresh download against
// it. The staged swap checks again before it unpacks an installer (updater.ts), because
// electron-updater hands back a CACHED download without re-running its check. The two lists must
// agree; updateSignature.test.ts reads electron-builder.yml and fails when they do not.

/** Distinguished names a Windows installer's Authenticode signer must match (every key given). */
export const WINDOWS_PUBLISHER_NAMES: readonly string[] = ['CN=SNOUTDATA, O=SNOUTDATA, C=CA'];

/**
 * The words for an installer that failed the check. electron-updater's verifier answers null for
 * "signed by us" and a description of the signature otherwise; the description can be long, so
 * only its start is kept.
 */
export function signatureRefusal(version: string, verifierAnswer: string): string {
	const detail = verifierAnswer.length > 300 ? `${verifierAnswer.slice(0, 300)}...` : verifierAnswer;
	return `The downloaded update to v${version} is not signed by SnoutData, so it was not installed. ${detail}`;
}
