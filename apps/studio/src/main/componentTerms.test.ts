/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { TermsStore, termsOf } from './componentTerms';
import { HANA_PREBUILT, IBM_CLI_DRIVER_TERMS, IBM_CLI_DRIVER_WIN32_X64, SAP_HANA_CLIENT_TERMS, hanaParts } from './componentVendors';

const dir = mkdtempSync(join(tmpdir(), 'snout-terms-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const hana = { parts: hanaParts(HANA_PREBUILT['linux-x64']) };
const db2 = { url: 'https://example.invalid/ibm_db.zip', sha256: '0'.repeat(64), bytes: 1, parts: [IBM_CLI_DRIVER_WIN32_X64] };

describe('vendor licences before a vendor download', () => {
	it('every part fetched from SAP or IBM carries that vendor\'s licence, with a link to its text', () => {
		assert.deepEqual(termsOf(hana).map((t) => t.id), [SAP_HANA_CLIENT_TERMS.id]);
		assert.deepEqual(termsOf(db2).map((t) => t.id), [IBM_CLI_DRIVER_TERMS.id]);
		for (const t of [SAP_HANA_CLIENT_TERMS, IBM_CLI_DRIVER_TERMS]) {
			assert.match(t.url, /^https:\/\//);
		}
		assert.equal(SAP_HANA_CLIENT_TERMS.url, 'https://tools.hana.ondemand.com/developer-license-3_2.txt');
	});

	it('a fresh profile has accepted nothing, so the download is refused before anything is fetched', () => {
		const store = new TermsStore(join(dir, 'fresh', 'componentTerms.json'));
		assert.deepEqual(store.pending(hana).map((t) => t.vendor), ['SAP']);
		assert.throws(() => store.assertAccepted(hana), /Nothing was downloaded: SAP's licence terms have not been accepted/);
		assert.throws(() => store.assertAccepted(db2), /IBM's licence terms/);
		assert.equal(existsSync(join(dir, 'fresh')), false, 'asking wrote nothing');
	});

	it('accepting one vendor\'s terms is remembered for this profile, and only for that vendor', () => {
		const file = join(dir, 'profile', 'componentTerms.json');
		new TermsStore(file).accept(SAP_HANA_CLIENT_TERMS);
		const reopened = new TermsStore(file);
		assert.doesNotThrow(() => reopened.assertAccepted(hana));
		assert.throws(() => reopened.assertAccepted(db2), /IBM/);
	});

	it('a licence at a new address has to be accepted again', () => {
		const file = join(dir, 'moved', 'componentTerms.json');
		const store = new TermsStore(file);
		store.accept(SAP_HANA_CLIENT_TERMS);
		const moved = { ...SAP_HANA_CLIENT_TERMS, url: 'https://tools.hana.ondemand.com/developer-license-3_3.txt' };
		assert.equal(store.isAccepted(moved), false);
	});

	it('a source with no vendor part needs no acceptance', () => {
		const store = new TermsStore(join(dir, 'none', 'componentTerms.json'));
		assert.doesNotThrow(() => store.assertAccepted({ url: 'https://example.invalid/x.zip', sha256: '0'.repeat(64), bytes: 1 }));
		assert.doesNotThrow(() => store.assertAccepted(undefined));
	});
});
