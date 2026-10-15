/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  A vendor's licence, accepted by a person before the vendor's file is fetched.
 *
 *  SAP's HANA client and IBM's Db2 driver are downloaded from SAP and IBM and used under their
 *  terms, not ours. Saying so in a sentence is not agreeing to them, so the download prompt shows
 *  each vendor's licence with a link to the text, and nothing of that vendor's is fetched until the
 *  person has said "I accept". The acceptance is remembered per profile (a file in userData), and
 *  is tied to the licence's own address, so a new licence is asked about again.
 *
 *  Free of electron so it is tested under plain Node (componentTerms.test.ts). The ComponentStore
 *  enforces it in main; the prompt only asks.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { VendorTerms } from '../shared/components';
import type { InstallSource } from './componentInstall';

/** The licences a source's vendor parts are used under, each once. */
export function termsOf(source: InstallSource | undefined): VendorTerms[] {
	const out: VendorTerms[] = [];
	for (const part of source?.parts ?? []) {
		if (part.terms && !out.some((t) => t.id === part.terms!.id)) {
			out.push(part.terms);
		}
	}
	return out;
}

interface Accepted {
	url: string;
	acceptedAt: string;
}

/** Which licences this profile has accepted, in a small JSON file. */
export class TermsStore {
	constructor(private readonly file: string) {}

	private read(): Record<string, Accepted> {
		try {
			const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { accepted?: Record<string, Accepted> };
			return parsed.accepted && typeof parsed.accepted === 'object' ? parsed.accepted : {};
		} catch {
			return {};
		}
	}

	/** Accepted, and for this text: a licence at a new address has not been accepted yet. */
	isAccepted(terms: VendorTerms): boolean {
		return this.read()[terms.id]?.url === terms.url;
	}

	accept(terms: VendorTerms, now: Date = new Date()): void {
		const accepted = this.read();
		accepted[terms.id] = { url: terms.url, acceptedAt: now.toISOString() };
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(this.file, JSON.stringify({ accepted }, null, '\t'));
	}

	/** The licences in `source` this profile has not accepted. */
	pending(source: InstallSource | undefined): VendorTerms[] {
		return termsOf(source).filter((terms) => !this.isAccepted(terms));
	}

	/** Throws, naming the vendor, when any licence in `source` has not been accepted. */
	assertAccepted(source: InstallSource | undefined): void {
		const pending = this.pending(source);
		if (pending.length > 0) {
			const vendors = pending.map((t) => t.vendor).join(' and ');
			throw new Error(`Nothing was downloaded: ${vendors}'s licence terms have not been accepted.`);
		}
	}
}
