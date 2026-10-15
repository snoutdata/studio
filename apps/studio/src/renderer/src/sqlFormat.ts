/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { format, type SqlLanguage } from 'sql-formatter';
import { dialectFor } from '../../shared/engine';
import type { KeywordCase } from './appSettings';

// Thin wrapper over sql-formatter: maps our driver ids to its dialects (via the central dialect
// strategy) and reuses the editor's keyword-case preference, so formatting matches completion.

/** Pretty-print `sql` for the given driver. Returns the input unchanged on a parse error. */
export function formatSql(sql: string, driver: string | undefined, keywordCase: KeywordCase): string {
	try {
		return format(sql, { language: dialectFor(driver).formatterLanguage as SqlLanguage, keywordCase });
	} catch {
		// sql-formatter throws on syntax it can't parse; leave the user's text untouched.
		return sql;
	}
}
