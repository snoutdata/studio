/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The read check for an engine the app cannot ask to refuse writes (`dialect/readOnly.ts`,
// mechanism `none`: Snowflake, SAP HANA, Db2, the TiDB and OceanBase flavors, and any driver the
// app does not know). There the statement check is the ONLY thing between an agent's "read" and the
// data, and a list of what is forbidden kept being one construct behind: Snowflake's flow operator
// (`SHOW TABLES ->> DROP TABLE orders`) runs the statement after it, and its anonymous procedure
// (`WITH p AS PROCEDURE () ... AS $$ ... $$ CALL p()`) runs whatever its body says, and both read
// as a SHOW or a WITH to a check that looks for write verbs.
//
// So on those engines a read is an ALLOW-list: exactly one statement, in every lexer's reading,
// that leads with SELECT, WITH (into a SELECT), SHOW, DESCRIBE/DESC, EXPLAIN (not ANALYZE, and not
// on Db2 or SAP HANA, where EXPLAIN writes the plan into the explain tables) or VALUES (and LIST/LS
// of a Snowflake stage), with none of the things a read never needs: a `->>`
// flow operator, a `$$` body, PROCEDURE, CALL, EXECUTE/EXEC, BEGIN, DECLARE, or a DML/DDL verb
// anywhere in it. Everything else the general check refuses (writing functions, SYSTEM$, sequence
// advances, SELECT INTO) is still refused by it; this runs in front of it, not instead of it.
//
// Pure, and it reads only the guard's blanked text, so a word in a string or a comment counts
// for nothing either way.

import { explainStoresPlan, guardReadings, writeVerbIn } from './sqlGuard';

/** What a read on a lexical-only engine may lead with. */
const LEAD = /^(select|with|show|describe|desc|explain|values)\b/i;

/** Snowflake lists the files on a stage with LIST (or LS), which reads. */
const SNOWFLAKE_LEAD = /^(list|ls)\b/i;

/** Words no read needs: a procedure, a call, a dynamic statement, a scripting block. */
const SCRIPTING = /\b(procedure|call|execute|exec|begin|declare)\b/i;

/** A dollar-quoted body (`$$ ... $$`, `$tag$ ... $tag$`), which the blanking leaves its delimiters. */
const DOLLAR = /(?:^|[^\w$])\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/** MySQL's family reads `->>` as JSON_UNQUOTE(JSON_EXTRACT(...)), not a flow operator. */
function jsonArrow(driver: string | undefined): boolean {
	return driver === 'mysql-aurora' || driver === 'mariadb';
}

/** `statement` with everything inside parentheses blanked, parentheses included. */
function depthZero(statement: string): string {
	let depth = 0;
	let out = '';
	for (const ch of statement) {
		if (ch === '(') {
			depth++;
		}
		out += depth > 0 ? ' ' : ch;
		if (ch === ')' && depth > 0) {
			depth--;
		}
	}
	return out;
}

/** One CTE of a WITH list once the bodies are blanked: `name [(cols)] AS [NOT] [MATERIALIZED]`, then a comma or not. */
const CTE = /^(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|[\w$#]+)\s+as\s+(?:not\s+)?(?:materialized\s+)?,?\s*/i;

/** Whether a WITH statement's CTE list leads into a SELECT (and not a procedure, a DML or nothing). */
function withLeadsIntoSelect(statement: string): boolean {
	let rest = depthZero(statement).replace(/^with\s+(?:recursive\s+)?/i, '');
	while (CTE.test(rest)) {
		rest = rest.replace(CTE, '');
	}
	return /^select\b/i.test(rest);
}

/** Why one blanked statement is not a plain read on a lexical-only engine, or undefined. */
function statementRefusal(raw: string, driver: string | undefined): string | undefined {
	const statement = raw.replace(/^[(\s]+/, '');
	if (statement.includes('->>') && !jsonArrow(driver)) {
		return 'it uses the ->> flow operator, which runs a second statement';
	}
	if (DOLLAR.test(statement)) {
		return 'it holds a $$ block (a procedure or script body)';
	}
	const scripting = SCRIPTING.exec(statement);
	if (scripting) {
		return `it contains ${scripting[1].toUpperCase()}`;
	}
	const lead = LEAD.exec(statement) ?? (driver === 'snowflake' ? SNOWFLAKE_LEAD.exec(statement) : null);
	if (!lead) {
		const word = /^[^\s(;,'"`[]+/.exec(statement)?.[0] ?? statement.slice(0, 1);
		return `it starts with ${word.toUpperCase()}`;
	}
	const verb = lead[1].toLowerCase();
	if (verb === 'with' && !withLeadsIntoSelect(statement)) {
		return 'its WITH does not lead into a SELECT';
	}
	if (verb === 'explain' && explainStoresPlan(driver)) {
		return 'EXPLAIN writes the plan into the explain tables here';
	}
	if (verb === 'explain' && /\banaly[sz]e\b/i.test(statement)) {
		return 'EXPLAIN ANALYZE runs the statement it explains';
	}
	// SHOW CREATE TABLE reads a table's DDL; every other DML/DDL word is a statement it would run.
	const write = writeVerbIn(verb === 'show' ? statement.replace(/^show\s+create\b/i, 'show') : statement);
	if (write) {
		return `it runs a ${write.verb}`;
	}
	return undefined;
}

/**
 * Why `sql` is not a plain read the allow-list admits, as a clause ("it contains CALL"), or
 * undefined when it is one. `driver` is the connection's driver id; every lexer it needs must read
 * exactly one statement, and that statement must pass.
 */
export function allowlistReadRefusal(sql: string, driver?: string): string | undefined {
	for (const statements of guardReadings(sql, driver)) {
		if (statements.length === 0) {
			return 'there is no statement';
		}
		if (statements.length > 1) {
			return 'it is more than one statement';
		}
		const refusal = statementRefusal(statements[0], driver);
		if (refusal) {
			return refusal;
		}
	}
	return undefined;
}
