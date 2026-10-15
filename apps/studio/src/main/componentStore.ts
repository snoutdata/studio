/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import { humanBytes, isFetchable, type DownloadOptions } from './componentDownload';
import { installSource, sourceBytes, sourcePins, type BundlePart, type InstallSource } from './componentInstall';
import { TermsStore, termsOf } from './componentTerms';
import { HANA_CLIENT_VERSION, HANA_PREBUILT, IBM_CLI_DRIVER_WIN32_X64, hanaParts } from './componentVendors';

import type {
	ComponentId,
	ComponentInfo,
	ComponentInstallProgress,
	ComponentRequirement,
	NativeRuntime,
	VendorTerms,
} from '../shared/components';

/** Release assets live on the public feed repo. One place to change when the tag moves. */
export const RUNTIME_URL = (asset: string): string => `https://github.com/snoutdata/studio/releases/download/components-v1/${asset}`;

/**
 * What one platform's copy of a component is made of: our own zip on the release feed (`url`,
 * `sha256`, `bytes`), pieces fetched straight from their publishers (`parts`, each pinned), or both.
 * A client the app downloads from its vendor is only ever a part.
 */
export type PlatformBundle = InstallSource;
export type { BundlePart };

export interface ComponentSpec {
	id: ComponentId;
	displayName: string;
	version: string;
	/** Keyed by `${process.platform}-${process.arch}` (e.g. "win32-x64"). Missing key = unsupported. */
	bundles: Partial<Record<string, PlatformBundle>>;
}

/**
 * The component registry. `node22` is the shared stock-Node runtime every native-driver sidecar
 * uses; `db2` is the ibm_db client, with IBM's driver fetched from IBM. Our own bundles are release
 * assets on the public feed repo (snoutdata/studio). For Db2 only win32-x64 is published; macOS/Linux
 * are a follow-up (the platform key is simply absent until then, and the driver reports
 * "unsupported" rather than half-installing).
 *
 * Our URLs/hashes are produced by the deploy/build-*-component(s).sh scripts and pasted here after
 * upload.
 */
const COMPONENTS: ComponentSpec[] = [
	{
		id: 'node22',
		displayName: 'Node 22 runtime',
		version: '22.22.1',
		bundles: {
			'win32-x64': {
				url: 'https://github.com/snoutdata/studio/releases/download/components-v1/node22-22.22.1-win32-x64.zip',
				sha256: 'd26c989c6fba88aca5431c54b48c267d4a6a4fc9bc56a8013eaf8dac667a8145',
				bytes: 33147585,
			},
		},
	},
	{
		// Our build of ibm_db (MIT) for the node22 sidecar, WITHOUT IBM's driver, plus IBM's driver
		// from IBM. The version stays 3.3.5: what lands on disk is the tree the earlier all-in-one
		// download unpacked to, so an existing install is still current and is not fetched again.
		id: 'db2',
		displayName: 'IBM Db2 client',
		version: '3.3.5',
		bundles: {
			'win32-x64': {
				url: RUNTIME_URL('ibm_db-3.3.5-win32-x64.zip'),
				sha256: 'ab795293bbd46d911fa0c24da5181fbe350f455c45773222be3e715a1cbd3fa7',
				bytes: 13_992_709,
				parts: [IBM_CLI_DRIVER_WIN32_X64],
			},
		},
	},
	{
		// snowflake-sdk + its dependency tree (~95 MB on disk, ~20 MB zipped; @azure / @aws-sdk / moment
		// dominate). Pure JS, so it loads in-process — no node22 runtime, no sidecar. Built by
		// deploy/build-snowflake-component.sh + uploaded to snoutdata/studio release components-v1.
		// Only win32-x64 is published: the Windows Compress-Archive zip uses backslash entry paths,
		// which Expand-Archive handles but `unzip` (mac/Linux) does not, so mac/Linux need a separate
		// forward-slash zip (a follow-up) and report "unsupported" until then — like Db2.
		id: 'snowflake',
		displayName: 'Snowflake client',
		version: '1.0.0',
		bundles: {
			'win32-x64': {
				url: 'https://github.com/snoutdata/studio/releases/download/components-v1/snowflake-1.0.0.zip',
				sha256: 'f150838572c9668069b9f80ed45ec77fd1fdfda5f13af2e9bf85ea383fe281a5',
				bytes: 20128935,
			},
		},
	},
	{
		// @duckdb/node-api + its per-platform native binding (duckdb.node + the big libduckdb shared
		// lib). N-API, so it loads in-process (no node22 sidecar), like Snowflake — but the payload is
		// native, unlike Snowflake's pure JS. Unlike Db2/Snowflake the binding is per-arch, so each
		// platform key needs its OWN bundle. Built by deploy/build-duckdb-component.sh (one isolated
		// per-platform install → `zip -r`, so the forward-slash zips extract on Windows/macOS/Linux
		// alike — no win32-only limitation) and uploaded to snoutdata/studio release components-v1. Dev
		// loads @duckdb/node-api from the devDependency instead (enforceComponents = app.isPackaged).
		id: 'duckdb',
		displayName: 'DuckDB client',
		version: '1.5.4',
		bundles: {
			'win32-x64': {
				url: 'https://github.com/snoutdata/studio/releases/download/components-v1/duckdb-1.5.4-win32-x64.zip',
				sha256: '276365e3dbfae0e382d927bc291cb53bcbd45ec505a49117cb4b87b01492d165',
				bytes: 13330787,
			},
			'darwin-arm64': {
				url: 'https://github.com/snoutdata/studio/releases/download/components-v1/duckdb-1.5.4-darwin-arm64.zip',
				sha256: 'b0f4b3dbcd3468fb907824979b6b86acfcbe3ef7dae419699af467deb492dd03',
				bytes: 35022763,
			},
			'darwin-x64': {
				url: 'https://github.com/snoutdata/studio/releases/download/components-v1/duckdb-1.5.4-darwin-x64.zip',
				sha256: '440d838099837b3d04de401c334c13b6f932cae33e6935dc18c9fdff84eb3334',
				bytes: 35026461,
			},
			'linux-x64': {
				url: 'https://github.com/snoutdata/studio/releases/download/components-v1/duckdb-1.5.4-linux-x64.zip',
				sha256: 'fef2b7db299fb6a5e7d23f02a4faacef296ca65da4f200146f67aef03f512a65',
				bytes: 23611888,
			},
		},
	},
	{
		// @sap/hana-client, the SAP HANA client: fetched from npm, never from us (see hanaParts).
		// Its native binary is N-API, so it loads in-process in the Electron server child, with no
		// node22 sidecar (the DuckDB model). Platforms absent here report "unsupported" rather than
		// half-installing. The version stays the client's: the tree on disk is the one the earlier
		// hosted download unpacked to, so an existing install is still current.
		id: 'hana',
		displayName: 'SAP HANA client',
		version: HANA_CLIENT_VERSION,
		bundles: Object.fromEntries(Object.entries(HANA_PREBUILT).map(([key, prebuilt]) => [key, { parts: hanaParts(prebuilt) }])),
	},
	{
		// The Postgres client tools a move runs: pg_dump, pg_restore and psql with the libraries
		// they load, from theseus-rs/postgresql-binaries 17.11.0 (PostgreSQL Licence, verified
		// against upstream's own hashes). NOT a driver: nothing connects through it, and it is
		// installed from the move's "tools missing" card. Built by
		// deploy/build-pgtools-component.sh on Linux (the linux libpq is a symlink chain), which
		// also runs the linux-x64 bundle. The Windows bundle carries the VC++ runtime DLLs, which
		// upstream omits and a clean Windows lacks.
		id: 'pgtools',
		displayName: 'Postgres tools',
		version: '17.11.0',
		bundles: {
			'win32-x64': { url: RUNTIME_URL('pgtools-17.11.0-win32-x64.zip'), sha256: 'c4150badc3774e69193b72ec2c93d22c261fb38bce77011f74174fba2b6f1d81', bytes: 5_046_772 },
			'linux-x64': { url: RUNTIME_URL('pgtools-17.11.0-linux-x64.zip'), sha256: 'f664a78d2358d2308239ccc440499fdd9e12266d01d482e0f6752af53d8a4ca9', bytes: 783_109 },
			'linux-arm64': { url: RUNTIME_URL('pgtools-17.11.0-linux-arm64.zip'), sha256: 'bfd26152821e3bce36037a804eb04a1688175205b3a74b9422845f4e83c9fb65', bytes: 757_124 },
			'darwin-arm64': { url: RUNTIME_URL('pgtools-17.11.0-darwin-arm64.zip'), sha256: '7c3e1379c8dc3fa59a86622e2d4d14060d5870216fba97100f74aff3287375b8', bytes: 3_330_326 },
			'darwin-x64': { url: RUNTIME_URL('pgtools-17.11.0-darwin-x64.zip'), sha256: '2371ac9ae22303671b4bf1221cebd95ba480f4efe184d0ef600c459115a80b79', bytes: 3_120_098 },
		},
	},
];

/** Which components a driver needs before it can connect. A driver absent here has no native
 *  component (the common case) and never triggers a download. */
const DRIVER_COMPONENTS: Partial<Record<string, ComponentId[]>> = {
	db2: ['node22', 'db2'],
	// snowflake-sdk is pure JS: just the one downloaded module tree, no node22 sidecar runtime.
	snowflake: ['snowflake'],
	// @duckdb/node-api is a native N-API addon that loads in-process: just the one module tree, no
	// node22 sidecar (its ABI-stable binary runs under Electron directly, unlike Db2's ibm_db).
	duckdb: ['duckdb'],
	// @sap/hana-client is likewise a native N-API addon loaded in-process — one module tree, no sidecar.
	hana: ['hana'],
};

const platformKey = (): string => `${process.platform}-${process.arch}`;

function spec(id: ComponentId): ComponentSpec {
	const found = COMPONENTS.find((c) => c.id === id);
	if (!found) {
		throw new Error(`unknown component '${id}'`);
	}
	return found;
}

function bundleFor(id: ComponentId): PlatformBundle | undefined {
	return spec(id).bundles[platformKey()];
}

/**
 * Manages the on-demand native-driver components: where they live, whether they're installed, and
 * downloading/verifying/extracting them. Lives in main (it needs the network + filesystem + the
 * userData path); the renderer drives it over IPC and the server child receives only the resolved
 * {@link NativeRuntime} paths on the connect config.
 */
export class ComponentStore {
	/** componentsRoot/<id>/ holds the extracted bundle; component.json records its version. */
	private readonly root = join(app.getPath('userData'), 'components');
	/** The vendor licences this profile has accepted. Kept outside `root`, so removing a
	 *  component does not forget that its licence was accepted. */
	private readonly terms = new TermsStore(join(app.getPath('userData'), 'componentTerms.json'));

	private dir(id: ComponentId): string {
		return join(this.root, id);
	}

	private manifestPath(id: ComponentId): string {
		return join(this.dir(id), 'component.json');
	}

	/** The installed version of a component, or undefined when absent / a stale partial. */
	private installedVersion(id: ComponentId): string | undefined {
		try {
			const raw = readFileSync(this.manifestPath(id), 'utf8');
			const parsed = JSON.parse(raw) as { version?: string };
			return parsed.version;
		} catch {
			return undefined;
		}
	}

	/** Where an installed component's files are, or undefined when it is not installed. */
	installedDir(id: ComponentId): string | undefined {
		return this.isInstalled(id) ? this.dir(id) : undefined;
	}

	isInstalled(id: ComponentId): boolean {
		return this.installedVersion(id) === spec(id).version;
	}

	info(id: ComponentId): ComponentInfo {
		const s = spec(id);
		const bundle = bundleFor(id);
		return {
			id,
			displayName: s.displayName,
			installed: this.isInstalled(id),
			version: this.installedVersion(id),
			downloadBytes: bundle ? sourceBytes(bundle) : undefined,
			supported: bundle !== undefined,
			// A registry entry whose checksum is still a placeholder has nothing behind it on the feed.
			published: bundle !== undefined && sourcePins(bundle).every(isFetchable),
		};
	}

	all(): ComponentInfo[] {
		return COMPONENTS.map((c) => this.info(c.id));
	}

	/**
	 * What a driver still needs before it can connect, or null when it needs nothing (no native
	 * component, or everything is already installed). `supported:false` means a required component
	 * has no bundle for this OS/arch yet — the caller should surface that rather than offer a
	 * download that can't work.
	 */
	requiredFor(driver: string): ComponentRequirement | null {
		const needed = DRIVER_COMPONENTS[driver];
		if (!needed) {
			return null;
		}
		const missing = needed.filter((id) => !this.isInstalled(id));
		if (missing.length === 0) {
			return null;
		}
		const supported = missing.every((id) => bundleFor(id) !== undefined);
		const bytes = missing.reduce((sum, id) => {
			const bundle = bundleFor(id);
			return sum + (bundle ? sourceBytes(bundle) : 0);
		}, 0);
		// Who each vendor piece comes from, said before anything is fetched.
		const notices = [...new Set(missing.flatMap((id) => (bundleFor(id)?.parts ?? []).map((part) => part.notice ?? '')).filter((notice) => notice !== ''))];
		// The licences still to accept; the prompt cannot start the download until each is.
		const terms: VendorTerms[] = [];
		for (const id of missing) {
			for (const t of this.terms.pending(bundleFor(id))) {
				if (!terms.some((known) => known.id === t.id)) {
					terms.push(t);
				}
			}
		}
		return { driver, missing, totalLabel: humanBytes(bytes), supported, notices, terms };
	}

	/**
	 * Record that the person accepted these vendor licences, by id. Only a licence one of the
	 * registered components really carries can be accepted; an unknown id is ignored.
	 */
	acceptTerms(ids: readonly string[]): void {
		for (const component of COMPONENTS) {
			for (const bundle of Object.values(component.bundles)) {
				for (const t of termsOf(bundle)) {
					if (ids.includes(t.id) && !this.terms.isAccepted(t)) {
						this.terms.accept(t);
					}
				}
			}
		}
	}

	/** Resolve the runtime for a native driver from its installed components, or undefined when a
	 *  required component isn't installed (the caller then triggers a download). */
	runtimeFor(driver: string): NativeRuntime | undefined {
		if (driver === 'db2') {
			if (!this.isInstalled('node22') || !this.isInstalled('db2')) {
				return undefined;
			}
			const nodeBin = join(this.dir('node22'), process.platform === 'win32' ? 'node.exe' : 'bin/node');
			// The db2 bundle is a self-contained node_modules (ibm_db + its runtime deps like `bindings`);
			// ibm_db self-resolves its clidriver from installer/clidriver relative to the module, so no
			// IBM_DB_HOME env is needed, and `require('bindings')` resolves to the sibling in node_modules.
			const modulePath = join(this.dir('db2'), 'node_modules', 'ibm_db', 'lib', 'odbc.js');
			if (!existsSync(nodeBin) || !existsSync(modulePath)) {
				return undefined;
			}
			return { nodeBin, modulePath };
		}
		if (driver === 'snowflake') {
			if (!this.isInstalled('snowflake')) {
				return undefined;
			}
			// Pure JS: the snowflake driver loads this in-process (no sidecar), so only modulePath
			// matters; nodeBin is unused. The bundle is a self-contained node_modules; require() of the
			// package dir resolves its deps from the sibling node_modules.
			const modulePath = join(this.dir('snowflake'), 'node_modules', 'snowflake-sdk');
			if (!existsSync(modulePath)) {
				return undefined;
			}
			return { nodeBin: '', modulePath };
		}
		if (driver === 'duckdb') {
			if (!this.isInstalled('duckdb')) {
				return undefined;
			}
			// Native N-API addon loaded in-process (no sidecar), so only modulePath matters. The bundle
			// is a self-contained node_modules; require() of the package dir resolves @duckdb/node-bindings
			// + the platform binary from the sibling node_modules.
			const modulePath = join(this.dir('duckdb'), 'node_modules', '@duckdb', 'node-api');
			if (!existsSync(modulePath)) {
				return undefined;
			}
			return { nodeBin: '', modulePath };
		}
		if (driver === 'hana') {
			if (!this.isInstalled('hana')) {
				return undefined;
			}
			// Native N-API addon loaded in-process (no sidecar), so only modulePath matters. The bundle
			// is a self-contained node_modules; require() of the package dir resolves its `debug`
			// dependency and the single prebuilt/<platform> driver from inside the package.
			const modulePath = join(this.dir('hana'), 'node_modules', '@sap', 'hana-client');
			if (!existsSync(modulePath)) {
				return undefined;
			}
			return { nodeBin: '', modulePath };
		}
		return undefined;
	}

	/** The `bin` directory of the installed Postgres tools a move runs, or
	 *  undefined when they are not installed. */
	pgToolsBin(): string | undefined {
		if (!this.isInstalled('pgtools')) {
			return undefined;
		}
		const bin = join(this.dir('pgtools'), 'bin');
		return existsSync(join(bin, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump')) ? bin : undefined;
	}

	/** Install one component: download every piece → verify each against its pin → extract →
	 *  write manifest. Idempotent; re-installing replaces a stale version. Streams progress to
	 *  `onProgress`. */
	async install(id: ComponentId, onProgress: (p: ComponentInstallProgress) => void, options: DownloadOptions = {}): Promise<void> {
		const bundle = bundleFor(id);
		if (!bundle) {
			throw new Error(`No ${spec(id).displayName} download is available for ${platformKey()} yet.`);
		}
		// Never fetch a vendor's file before its licence was accepted, whoever is asking.
		this.terms.assertAccepted(bundle);
		mkdirSync(this.root, { recursive: true });
		const workDir = join(this.root, `${id}.download`);
		try {
			const dest = this.dir(id);
			await installSource(bundle, dest, workDir, spec(id).displayName, (phase, received, total) => {
				onProgress(phase === 'download' ? { id, phase, receivedBytes: received ?? 0, totalBytes: total } : { id, phase });
			}, options);
			ensureExecutable(id, dest);
			rmSync(workDir, { recursive: true, force: true });
			writeFileSync(this.manifestPath(id), JSON.stringify({ id, version: spec(id).version }));

			onProgress({ id, phase: 'done' });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			onProgress({ id, phase: 'error', error: message });
			throw err;
		}
	}

	/**
	 * Delete an installed component's files.
	 *
	 * A thing a user can install from a screen has to be removable from the same screen, without a
	 * file manager and a guess at the path. Bounded to this store's own root so a bad id can never
	 * delete anything else.
	 */
	remove(id: ComponentId): void {
		const dest = this.dir(id);
		if (!dest.startsWith(this.root)) {
			return;
		}
		rmSync(dest, { recursive: true, force: true });
	}

	/** Install every component a driver needs that isn't already present, in order. */
	async installFor(driver: string, onProgress: (p: ComponentInstallProgress) => void): Promise<void> {
		const needed = DRIVER_COMPONENTS[driver] ?? [];
		// Checked for the whole set first, so a refused licence does not leave half of it fetched.
		for (const id of needed) {
			if (!this.isInstalled(id)) {
				this.terms.assertAccepted(bundleFor(id));
			}
		}
		for (const id of needed) {
			if (!this.isInstalled(id)) {
				await this.install(id, onProgress);
			}
		}
	}
}

/* isPlaceholder, humanBytes, downloadFile and sha256File moved to componentDownload.ts, where they
 * can be tested under plain Node (this file imports electron) and where the model-sized download
 * they now have to survive is handled: streaming hashes, resumable transfers, a stall timeout.
 * Unpacking (zip, and the npm tarballs a vendor piece arrives as) is in componentInstall.ts, for
 * the same reason. */

/**
 * Make the extracted runtime launcher executable, on the platforms where that is a thing.
 *
 * **Why this is not left to the archive.** A build script chmods the binary before zipping and
 * `unzip` does restore the mode, so the published bundles extract 0755 and spawn with nothing added
 * — verified on macOS against the real artifact. That is the happy path, and it depends on a mode
 * bit surviving a build host's umask, a zip tool's choices and an external `unzip`'s behaviour, none
 * of which this app controls or checks. The failure when any of them slips is
 * `spawn … EACCES`: a runtime that downloads, verifies, extracts and then cannot start — the exact
 * shape of A.6 and A.16, which this project has now shipped twice and caught twice by running the
 * thing rather than by inspecting it.
 *
 * So the app guarantees it instead of assuming it. It is one syscall on a file we just wrote,
 * it is a no-op when the bit is already right, and being wrong in this direction costs nothing.
 * Windows has no execute bit and needs none.
 */
const EXECUTABLES: Partial<Record<ComponentId, readonly string[]>> = {
	pgtools: ['bin/pg_dump', 'bin/pg_restore', 'bin/psql'],
};

function ensureExecutable(id: ComponentId, dest: string): void {
	if (process.platform === 'win32') {
		return;
	}
	for (const relative of EXECUTABLES[id] ?? []) {
		const binary = join(dest, relative);
		if (existsSync(binary)) {
			chmodSync(binary, 0o755);
		}
	}
}

/**
 * Add a component the app does not build in itself. Data Flows' local model runtime registers its
 * own (it is private, so the open tree names none of its downloads);
 * `executables` are the files to mark executable after extraction, as `EXECUTABLES` does for the
 * built-in ones. Registering the same id twice is a no-op.
 */
export function registerComponent(component: ComponentSpec, executables: readonly string[] = []): void {
	if (COMPONENTS.some((c) => c.id === component.id)) {
		return;
	}
	COMPONENTS.push(component);
	if (executables.length > 0) {
		EXECUTABLES[component.id] = executables;
	}
}
