/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The database clients the app downloads from their vendors rather than from SnoutData, and
 *  exactly which file of each it fetches. Every entry is pinned to one file by a hash written here.
 *
 *  Apart from componentStore.ts (which imports electron) so the pins can be checked against the
 *  real publishers by a plain Node test (componentVendors.test.ts).
 *--------------------------------------------------------------------------------------------*/

import type { VendorTerms } from '../shared/components';
import type { BundlePart } from './componentInstall';

/**
 * IBM's terms for the Db2 driver. The zip's own License Information
 * (`clidriver/license/Windows/odbc_LI_en.rtf`, "IBM Data Server Driver for ODBC and CLI v12.1.2")
 * names the International Program License Agreement i125-3301-15 as the terms that apply, and that
 * is the text linked here.
 */
export const IBM_CLI_DRIVER_TERMS: VendorTerms = {
	id: 'ibm-db2-cli-driver',
	vendor: 'IBM',
	title: 'IBM International Program License Agreement (i125-3301-15)',
	url: 'https://www.ibm.com/support/customer/csol/terms/?id=i125-3301-15&lc=en',
	file: 'clidriver/license/Windows/odbc_LI_en.rtf',
};

/**
 * SAP's terms for the HANA client. The package's own `license` field is "SEE LICENSE IN
 * developer-license-3_2.txt", the SAP Developer License Agreement 3.2, published at this address.
 */
export const SAP_HANA_CLIENT_TERMS: VendorTerms = {
	id: 'sap-hana-client',
	vendor: 'SAP',
	title: 'SAP Developer License Agreement 3.2',
	url: 'https://tools.hana.ondemand.com/developer-license-3_2.txt',
	file: '@sap/hana-client/developer-license-3_2.txt',
};

/**
 * IBM's Db2 ODBC/CLI driver ("clidriver"), fetched from IBM's own download site at install time.
 *
 * Our Db2 zip carries `ibm_db` (MIT) and nothing of IBM's; the driver itself comes from IBM, used
 * under IBM's licence, and this piece lands where `ibm_db` looks for it (`installer/clidriver`), so
 * it loads exactly as it did when it came inside our zip.
 *
 * PINNED to a version folder, never the folder's root: IBM replaces the files at the root with
 * each release, so a pin on the root would break the day they ship. v12.1.2 is the driver our
 * earlier Db2 download carried (the same `db2app64.dll`), so the driver a user runs does not change.
 */
export const IBM_CLI_DRIVER_WIN32_X64: BundlePart = {
	url: 'https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/v12.1.2/ntx64_odbc_cli.zip',
	integrity: 'ccdbf2413c0612fec026309a75638da5bd4afcce9cb5a8d51d1dde80c32ec7fb',
	bytes: 27_235_419,
	format: 'zip',
	into: 'node_modules/ibm_db/installer',
	notice: "IBM's Db2 driver is downloaded from IBM and used under IBM's licence.",
	terms: IBM_CLI_DRIVER_TERMS,
};

/** The SAP HANA client version, and npm's own integrity string for its tarball. */
export const HANA_CLIENT_VERSION = '2.29.25';
export const HANA_CLIENT_INTEGRITY = 'sha512-yX8N9hE5S7vDkCTxEoD33JRRbHv0aa3Kqhd5FVlaqv+xNKMtZDgtZmXPe29KLo3Y5GjZhpoqixr/1mt0C2Ahjw==';

/** Which `prebuilt/` folder of the HANA package each platform runs (what the package's own
 *  lib/index.js picks for that platform). Windows is x64 only in this client. */
export const HANA_PREBUILT: Readonly<Record<string, string>> = {
	'win32-x64': 'ntamd64',
	'darwin-arm64': 'darwinarm64',
	'darwin-x64': 'darwinintel64',
	'linux-x64': 'linuxx86_64',
	'linux-arm64': 'linuxaarch64',
};

/**
 * SAP's HANA client, straight from the npm registry, never from us.
 *
 * The app fetches SAP's own package from registry.npmjs.org, used under SAP's licence, checks it
 * against npm's `dist.integrity` for this exact version (written here, so a republished or
 * substituted tarball is refused), and unpacks only this computer's platform out of the seven it
 * carries. Its two dependencies (`debug`, `ms`, both MIT) come the same way, pinned to
 * the versions SAP's own shrinkwrap names. The result is the same `node_modules` tree our hosted
 * HANA download used to unpack to, so a client installed either way loads the same.
 */
export function hanaParts(prebuilt: string): BundlePart[] {
	return [
		{
			url: `https://registry.npmjs.org/@sap/hana-client/-/hana-client-${HANA_CLIENT_VERSION}.tgz`,
			integrity: HANA_CLIENT_INTEGRITY,
			bytes: 40_093_343,
			format: 'tgz',
			into: 'node_modules/@sap/hana-client',
			strip: 'package',
			only: { dir: 'prebuilt', keep: prebuilt },
			notice: "The SAP HANA client is downloaded from SAP's package on npm and used under SAP's licence.",
			terms: SAP_HANA_CLIENT_TERMS,
		},
		{
			url: 'https://registry.npmjs.org/debug/-/debug-3.1.0.tgz',
			integrity: 'sha512-OX8XqP7/1a9cqkxYw2yXss15f26NKWBpDXQd0/uK/KPqdQhxbPa994hnzjcE2VqQpDslf55723cKPUOGSmMY3g==',
			bytes: 17_183,
			format: 'tgz',
			into: 'node_modules/debug',
			strip: 'package',
		},
		{
			url: 'https://registry.npmjs.org/ms/-/ms-2.0.0.tgz',
			integrity: 'sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A==',
			bytes: 2_874,
			format: 'tgz',
			into: 'node_modules/ms',
			strip: 'package',
		},
	];
}
