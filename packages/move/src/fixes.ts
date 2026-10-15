/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The only way a finding changes a spec.
 *
 * A fix is applied against the finding that offered it, and a fix the finding did not offer is
 * refused with the ones it did, which is the sentence a model needs to correct itself.
 */

import type { Finding } from './preflight.js';
import type { FixId, MoveSpec } from './spec.js';

export type FixResult = { readonly ok: true; readonly spec: MoveSpec } | { readonly ok: false; readonly error: string };

export function findFinding(findings: readonly Finding[], key: string): Finding | null {
	return findings.find((finding) => finding.key === key) ?? null;
}

export function applyFix(spec: MoveSpec, finding: Finding, fix: FixId): FixResult {
	if (spec.status === 'ready') {
		return { ok: false, error: "This move is marked ready to run, so it can no longer be edited." };
	}
	if (!finding.fixes.includes(fix)) {
		return {
			ok: false,
			error:
				finding.fixes.length > 0
					? `"${fix}" is not a fix for ${finding.key}. Its fixes are: ${finding.fixes.join(', ')}.`
					: `${finding.key} has no fix to choose. It changes only when the databases do.`
		};
	}

	switch (fix) {
		case 'continue':
		case 'continueWithout':
			return {
				ok: true,
				spec: {
					...spec,
					resolved: [...spec.resolved.filter((resolved) => resolved.key !== finding.key), { key: finding.key, fix }]
				}
			};
		case 'replaceTarget':
			return { ok: true, spec: { ...spec, targetMode: 'replace' } };
		case 'skipOwnership':
			return { ok: true, spec: { ...spec, ownership: 'skip', privileges: 'skip' } };
		case 'keepSource':
			return { ok: true, spec: { ...spec, sourceAfter: 'keep' } };
		case 'excludeSchema': {
			const schema = finding.object;
			if (!schema) {
				return { ok: false, error: `${finding.key} names no schema to exclude.` };
			}
			const selection = spec.selection;
			return {
				ok: true,
				spec: {
					...spec,
					selection: {
						...selection,
						schemas: selection.schemas === null ? null : selection.schemas.filter((name) => name !== schema),
						excludeSchemas: [
							...selection.excludeSchemas.filter((exclusion) => exclusion.schema !== schema),
							{ schema, reason: finding.sentence }
						]
					}
				}
			};
		}
		case 'excludeExtension': {
			const extension = finding.object;
			if (!extension) {
				return { ok: false, error: `${finding.key} names no extension to exclude.` };
			}
			const selection = spec.selection;
			return {
				ok: true,
				spec: {
					...spec,
					selection: {
						...selection,
						excludeExtensions: [
							...selection.excludeExtensions.filter((exclusion) => exclusion.extension !== extension),
							{ extension, reason: finding.sentence }
						]
					}
				}
			};
		}
		case 'removeSchema': {
			const schema = finding.object;
			if (!schema || spec.selection.schemas === null) {
				return { ok: false, error: `${finding.key} names no schema in the selection.` };
			}
			return {
				ok: true,
				spec: {
					...spec,
					selection: { ...spec.selection, schemas: spec.selection.schemas.filter((name) => name !== schema) }
				}
			};
		}
		default: {
			const unknown: never = fix;
			return { ok: false, error: `Unknown fix: ${String(unknown)}.` };
		}
	}
}
