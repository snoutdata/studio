/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Who reads the user's data, and where it goes when they do: the choice of reader (the parsers,
 *  the model on this computer, our AI, their own model) and the boundary each one crosses.
 *
 *  Shared by two features that must not fork it: Data Flows' reader choice (which re-exports these
 *  and computes the flow's sentences) and the database PR reviewer's method
 *  (`shared/review.ts`, `ReviewMethod = FlowReader`). It lives here, outside the flow layer, because
 *  the reviewer is in every build and Data Flows is not.
 *
 *  Pure.
 *--------------------------------------------------------------------------------------------*/

/** Which BYOK backend, since they do not share a data boundary. */
export type ByokProvider = 'ollama' | 'openai' | 'anthropic' | 'openrouter';

export type FlowReader =
	/** The parsers we already had. Nothing is sent anywhere, and nothing can be. */
	| { kind: 'deterministic' }
	/**
	 * The model on this computer, served by our own local runtime.
	 *
	 * No consent literal, and that is deliberate rather than an oversight: consent gates data
	 * LEAVING, and nothing leaves here. What this does cost is time and power on the user's
	 * machine, which the screen says instead.
	 */
	| { kind: 'localEngine' }
	/**
	 * Our gateway. `consent: true` is a literal for the same reason it is on `llmExtract`: a spec
	 * cannot express sending the user's documents to us without the wizard having asked.
	 */
	| { kind: 'snoutAi'; consent: true }
	/**
	 * Their own model. `host` is only meaningful for `ollama`, where it may be this machine or a
	 * box on their network; the vendor providers always reach a third party.
	 *
	 * The key itself is NEVER here. A spec is saved to disk in the clear, so this names a provider
	 * and main resolves the secret from the keychain, exactly as a connection does.
	 */
	| {
		kind: 'byok';
		provider: ByokProvider;
		model: string;
		/** `ollama` only: `http://127.0.0.1:11434`, or a machine on their network. */
		host?: string;
		consent: true;
	};

/** Where a reader's data goes. `local` means it cannot leave, not that we would rather it did not. */
export type DataBoundary = 'local' | 'ourServers' | 'theirNetwork' | 'thirdParty';

/** Loopback and the names that mean it. A user's own machine is not "somewhere else". */
const LOOPBACK = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?\/?$/i;

export function isLocalHost(host: string | undefined): boolean {
	return host === undefined || host.trim() === '' || LOOPBACK.test(host.trim());
}
