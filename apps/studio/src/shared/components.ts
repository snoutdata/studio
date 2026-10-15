/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Contracts for on-demand "native driver components": large native payloads (a stock Node
// runtime, a vendor's native client + its bundled libraries) that we do NOT bundle in the base
// installer because most users never use that driver. They are downloaded + cached on first use
// (the first connect to such a driver), DBeaver-style. Db2 is the first consumer; the same
// machinery serves any future native-addon driver (SAP HANA, etc.) that can't load under
// Electron's ABI. Pure types only — shared by main, preload, and the renderer.

/** A downloadable component. `node22` is the shared stock-Node runtime every native-driver
 *  sidecar uses; the rest are per-driver payloads. `snowflake` is the pure-JS snowflake-sdk +
 *  its (~95 MB) dependency tree — downloaded on demand rather than bundled, but loaded in-process
 *  (no sidecar, no node22) since it has no native binary, unlike `db2`. `duckdb` and `hana` are
 *  native but N-API (ABI-stable), so they too load in-process; being native they are per-arch, so
 *  each publishes one bundle per platform. */
export type BuiltInComponentId = 'node22' | 'db2' | 'snowflake' | 'duckdb' | 'hana' | 'pgtools';

/** Any component: a built-in one, or one a private package registered (Data Flows' local model
 *  runtime), which the open tree does not name. */
export type ComponentId = BuiltInComponentId | (string & {});

/**
 * What the server child needs to spawn a native-driver sidecar, resolved from installed
 * components in main and passed down on the connect config (never persisted). Generic across
 * native drivers: `nodeBin` is the stock Node, `modulePath` the native module's entry to require,
 * `env` any extra process env the module needs (e.g. Db2's IBM_DB_HOME → the clidriver dir).
 */
export interface NativeRuntime {
	nodeBin: string;
	modulePath: string;
	env?: Record<string, string>;
}

/** Current install state of one component (for the Settings / prompt UI). */
export interface ComponentInfo {
	id: ComponentId;
	displayName: string;
	installed: boolean;
	version?: string;
	/** Download size on the current platform, bytes (undefined when the platform is unsupported). */
	downloadBytes?: number;
	/** False when no bundle is published for the current OS/arch yet. */
	supported: boolean;
	/**
	 * False while the registry entry for this platform still has a placeholder checksum, which is
	 * the record that nothing has been uploaded for it: the URL would 404.
	 *
	 * Separate from `supported`, because they are different facts with different answers. "We do not
	 * build one for your computer" is permanent for that machine; "it is not on our feed yet" is a
	 * thing that changes the day it ships, and a user who is told the first when the second is true
	 * has been told something wrong about their own hardware.
	 */
	published: boolean;
}

/** What a driver needs before it can connect, computed in main. `null` from `requiredFor` means
 *  nothing to download (already installed, or the driver has no native component). */
export interface ComponentRequirement {
	driver: string;
	/** The components still missing for this driver. */
	missing: ComponentId[];
	/** Combined human size label for the missing set, e.g. "162 MB". */
	totalLabel: string;
	/** False when any required component has no bundle for this OS/arch (can't proceed). */
	supported: boolean;
	/** One sentence per vendor piece that is fetched from its publisher rather than from us, naming
	 *  who publishes it and under what licence. Shown at the download prompt. */
	notices?: string[];
	/** The vendor licences this profile has not accepted yet. The download is refused in main
	 *  until each one is accepted (`componentsAcceptTerms`), so the prompt has to ask. */
	terms?: VendorTerms[];
}

/** A vendor's licence that a person accepts before the vendor's file is downloaded. */
export interface VendorTerms {
	/** Stable key the acceptance is stored under, e.g. `sap-hana-client`. */
	id: string;
	/** Who publishes it, as the acceptance reads: "SAP", "IBM". */
	vendor: string;
	/** The licence's name. */
	title: string;
	/** Where its text is. Acceptance is tied to this address, so new terms are asked about again. */
	url: string;
	/** The file inside the download that carries the same terms, when there is one. */
	file?: string;
}

/** Streamed to the renderer over the `components:progress` channel during an install. */
export interface ComponentInstallProgress {
	id: ComponentId;
	phase: 'download' | 'verify' | 'extract' | 'done' | 'error';
	receivedBytes?: number;
	totalBytes?: number;
	error?: string;
}

export type ComponentInstallResult = { ok: true } | { ok: false; error: string };

/**
 * Sentinel an upstream connect/test throws when a driver's native component is missing, so any
 * connect path (sidebar, auto-connect, test) surfaces the same signal. The renderer detects the
 * prefix on the error message, prompts the download, then retries. Carries the driver id.
 */
export const COMPONENT_REQUIRED_PREFIX = 'COMPONENT_REQUIRED:';

export function componentRequiredError(driver: string): Error {
	return new Error(`${COMPONENT_REQUIRED_PREFIX}${driver}`);
}

/** Returns the driver id if `message` is a component-required sentinel, else undefined. */
export function parseComponentRequired(message: string | undefined): string | undefined {
	if (!message) {
		return undefined;
	}
	const idx = message.indexOf(COMPONENT_REQUIRED_PREFIX);
	return idx === -1 ? undefined : message.slice(idx + COMPONENT_REQUIRED_PREFIX.length).trim();
}
