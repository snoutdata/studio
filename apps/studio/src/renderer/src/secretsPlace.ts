/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Where a saved secret (a password, an API key, a token) actually lives, for a sentence that tells
// the user. Usually the OS keychain; on a Linux desktop with no keyring, a file only the user's
// account can read (main/secretStorageMode.ts). A sentence that promised a keychain there would be
// false, so every such sentence takes its place from here. One IPC read per window, off any boot path
// (a settings screen asks the first time it opens).

import { useEffect, useState } from 'react';

let weakRead: Promise<boolean> | undefined;

function readWeak(): Promise<boolean> {
	weakRead ??= window.sqlApi.secretStorage.status().then((s) => s.weak).catch(() => false);
	return weakRead;
}

/** True when secrets are saved in a file instead of a keychain. False until the answer arrives. */
export function useSecretsWeak(): boolean {
	const [weak, setWeak] = useState(false);
	useEffect(() => {
		let alive = true;
		void readWeak().then((w) => {
			if (alive) {
				setWeak(w);
			}
		});
		return () => {
			alive = false;
		};
	}, []);
	return weak;
}

/** The end of "The key is kept …": where a secret saved now will be. */
export function secretsPlace(weak: boolean): string {
	return weak ? "in a file on this computer that only your user account can read" : "in this computer's keychain";
}
