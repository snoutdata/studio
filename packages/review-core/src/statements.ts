/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  From a changed file to the statements this pull request is responsible for.
 *
 *  Two sources, in order of preference:
 *    1. The file's FULL new content plus the diff's added line numbers. A statement is reviewed
 *       when any of its lines is new. This is the right way: a one-line change inside a large
 *       CREATE TABLE is reviewed as the whole CREATE TABLE, because that is what will run.
 *    2. The added lines alone, when the host could not fetch content. Honest but lossy — a
 *       statement that starts in unchanged context arrives clipped — so the caller is told, and
 *       the report prints it as a gap.
 *--------------------------------------------------------------------------------------------*/

import type { ChangedFile } from './diff.js';
import type { SqlLexRules } from './sql/mask.js';
import { splitStatements } from './sql/split.js';
import type { ReviewStatement } from './types.js';

export interface FileStatements {
	file: string;
	statements: ReviewStatement[];
	/** True when only the added lines were available, so statements may be incomplete. */
	fromAddedLinesOnly: boolean;
}

/** A short, stable id for a statement: file + line, which survives a re-push that did not
 *  move it. Findings hang off this, so an unchanged finding keeps its identity. */
function statementId(file: string, line: number): string {
	let hash = 0;
	const key = `${file}:${line}`;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) | 0;
	}
	return `s${(hash >>> 0).toString(36)}`;
}

/**
 * The statements in one changed file, each marked with whether the PR touched it.
 * `content` is the file's full new text; omit it to fall back to the diff's added lines.
 */
export function statementsForFile(file: ChangedFile, content?: string, rules?: SqlLexRules): FileStatements {
	const usingContent = typeof content === 'string' && content.length > 0;
	const text = usingContent ? content! : file.addedText;
	const added = new Set(file.addedLines);

	const statements: ReviewStatement[] = [];
	if (usingContent) {
		for (const span of splitStatements(text, rules)) {
			let touched = false;
			for (let line = span.line; line <= span.endLine; line++) {
				if (added.has(line)) {
					touched = true;
					break;
				}
			}
			statements.push({
				id: statementId(file.path, span.line),
				sql: span.sql,
				file: file.path,
				line: span.line,
				touched,
			});
		}
	} else {
		// Added lines only: every statement in them is by definition touched, and the line
		// numbers come from the diff so a finding still points at the right place.
		const lines = file.addedLines;
		for (const span of splitStatements(text, rules)) {
			// `span.line` is 1-based within `addedText`, whose Nth line is `addedLines[N-1]`.
			const line = lines[span.line - 1] ?? lines[0] ?? 1;
			statements.push({
				id: statementId(file.path, line),
				sql: span.sql,
				file: file.path,
				line,
				touched: true,
			});
		}
	}

	return { file: file.path, statements, fromAddedLinesOnly: !usingContent };
}

/** Every statement the PR touched, across every changed file, in file order. */
export function touchedStatements(
	files: ChangedFile[],
	contents?: Record<string, string>,
	rules?: SqlLexRules,
): { statements: ReviewStatement[]; clipped: string[] } {
	const statements: ReviewStatement[] = [];
	const clipped: string[] = [];
	for (const file of files) {
		const result = statementsForFile(file, contents?.[file.path], rules);
		// A file the PR ADDED is complete in its own added lines, so there is nothing clipped
		// and nothing to apologise for. Only a modified file can lose context this way.
		if (result.fromAddedLinesOnly && file.status !== 'added') {
			clipped.push(file.path);
		}
		for (const statement of result.statements) {
			if (statement.touched) {
				statements.push(statement);
			}
		}
	}
	return { statements, clipped };
}
