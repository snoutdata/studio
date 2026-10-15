/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from '../../shared/engine';
import { monaco } from './monaco';

// Monaco's built-in `sql` grammar + the stock vs/vs-dark themes mis-handle a few
// things our users hit immediately: multi-word keywords (INNER JOIN), and common
// identifiers that happen to sit in Monaco's builtin list rendering as keywords. We
// replace the tokenizer with a curated one tuned for the MySQL/Postgres dialects we
// target, and define explicit token colors under our Dark/Light Modern palette.

// All the words we want colored as keywords. Multi-word constructs (GROUP BY, INNER
// JOIN) need no special handling — each word is in this set, so both tokens color.
const KEYWORDS = [
	'ADD', 'ALL', 'ALTER', 'ANALYZE', 'AND', 'ANY', 'AS', 'ASC', 'AUTO_INCREMENT', 'BEGIN',
	'BETWEEN', 'BOTH', 'BY', 'CASCADE', 'CASE', 'CAST', 'CHANGE', 'CHECK', 'COLLATE', 'COLUMN',
	'COMMENT', 'COMMIT', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT', 'CURRENT_DATE',
	'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER', 'DATABASE', 'DATABASES', 'DECLARE',
	'DEFAULT', 'DEFERRABLE', 'DELETE', 'DESC', 'DESCRIBE', 'DISTINCT', 'DO', 'DROP', 'ELSE',
	'END', 'ESCAPE', 'EXCEPT', 'EXISTS', 'EXPLAIN', 'FALSE', 'FETCH', 'FILTER', 'FIRST',
	'FOR', 'FOREIGN', 'FROM', 'FULL', 'FULLTEXT', 'FUNCTION', 'GENERATED', 'GRANT', 'GROUP',
	'HAVING', 'IF', 'IGNORE', 'ILIKE', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT',
	'INTERVAL', 'INTO', 'IS', 'JOIN', 'KEY', 'LANGUAGE', 'LAST', 'LATERAL', 'LEADING', 'LEFT',
	'LIKE', 'LIMIT', 'LOCK', 'MATCH', 'MODIFY', 'NATURAL', 'NEXT', 'NOT', 'NULL', 'NULLS',
	'OFFSET', 'ON', 'ONLY', 'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION', 'PRIMARY', 'PROCEDURE',
	'RECURSIVE', 'REFERENCES', 'REGEXP', 'RENAME', 'REPLACE', 'RESTRICT', 'RETURNING', 'RETURNS',
	'REVOKE', 'RIGHT', 'RLIKE', 'ROLLBACK', 'ROW', 'ROWS', 'SCHEMA', 'SELECT', 'SET', 'SHOW',
	'SOME', 'TABLE', 'TABLES', 'TEMPORARY', 'THEN', 'TO', 'TRAILING', 'TRIGGER', 'TRUE',
	'TRUNCATE', 'UNION', 'UNIQUE', 'UNLOCK', 'UNSIGNED', 'UPDATE', 'USE', 'USING', 'VALUES',
	'VIEW', 'WHEN', 'WHERE', 'WINDOW', 'WITH', 'WITHOUT', 'ZEROFILL',
];

// SQL data types — colored distinctly (like a type, not a keyword).
const TYPES = [
	'BIGINT', 'BINARY', 'BIT', 'BLOB', 'BOOL', 'BOOLEAN', 'BYTEA', 'CHAR', 'CHARACTER',
	'DATE', 'DATETIME', 'DECIMAL', 'DOUBLE', 'ENUM', 'FLOAT', 'INT', 'INT2', 'INT4', 'INT8',
	'INTEGER', 'JSON', 'JSONB', 'LONGBLOB', 'LONGTEXT', 'MEDIUMINT', 'MEDIUMTEXT', 'MONEY',
	'NUMERIC', 'NVARCHAR', 'REAL', 'SERIAL', 'SMALLINT', 'TEXT', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ',
	'TINYINT', 'TINYTEXT', 'UUID', 'VARBINARY', 'VARCHAR', 'XML', 'YEAR',
];

// Common builtin functions — colored like calls (not as plain identifiers).
const FUNCTIONS = [
	'ABS', 'AVG', 'CEIL', 'CEILING', 'COALESCE', 'CONCAT', 'CONCAT_WS', 'COUNT', 'DATE_ADD',
	'DATE_FORMAT', 'DATE_SUB', 'DATEDIFF', 'DAY', 'EXTRACT', 'FLOOR', 'GREATEST', 'GROUP_CONCAT',
	'HOUR', 'IFNULL', 'JSON_EXTRACT', 'LEAST', 'LENGTH', 'LOWER', 'LPAD', 'LTRIM', 'MAX', 'MIN',
	'MINUTE', 'MONTH', 'NOW', 'NULLIF', 'POSITION', 'POWER', 'RANK', 'ROUND', 'ROW_NUMBER',
	'RPAD', 'RTRIM', 'SECOND', 'SQRT', 'SUBSTR', 'SUBSTRING', 'SUM', 'TRIM', 'UPPER',
];

const language: monaco.languages.IMonarchLanguage & { keywords: string[]; builtinTypes: string[] } = {
	defaultToken: '',
	ignoreCase: true,
	keywords: KEYWORDS,
	builtinTypes: TYPES,
	builtinFunctions: FUNCTIONS,
	tokenizer: {
		root: [
			{ include: '@comments' },
			{ include: '@whitespace' },
			{ include: '@numbers' },
			{ include: '@strings' },
			[/[;,.]/, 'delimiter'],
			[/[()[\]]/, '@brackets'],
			[
				/[\w$#@]+/,
				{
					cases: {
						'@keywords': 'keyword',
						'@builtinTypes': 'type',
						'@builtinFunctions': 'predefined',
						'@default': 'identifier',
					},
				},
			],
			[/[<>=!%&+\-*/|~^:]+/, 'operator'],
		],
		whitespace: [[/\s+/, 'white']],
		comments: [
			[/--+.*/, 'comment'],
			[/#.*/, 'comment'],
			[/\/\*/, { token: 'comment.quote', next: '@comment' }],
		],
		comment: [
			[/[^*/]+/, 'comment'],
			[/\*\//, { token: 'comment.quote', next: '@pop' }],
			[/./, 'comment'],
		],
		numbers: [
			[/0[xX][0-9a-fA-F]+/, 'number'],
			[/((\d+(\.\d*)?)|(\.\d+))([eE][-+]?\d+)?/, 'number'],
		],
		strings: [
			[/'/, { token: 'string', next: '@string' }],
			[/"/, { token: 'identifier.quote', next: '@quotedIdentifier' }],
			[/`/, { token: 'identifier.quote', next: '@backtickIdentifier' }],
		],
		// Single quotes are string literals ('' is an embedded quote).
		string: [
			[/[^']+/, 'string'],
			[/''/, 'string'],
			[/'/, { token: 'string', next: '@pop' }],
		],
		// ANSI/Postgres double-quoted and MySQL backtick-quoted identifiers — colored
		// as identifiers, not strings (this is the main cause of "pink fields").
		quotedIdentifier: [
			[/[^"]+/, 'identifier'],
			[/""/, 'identifier'],
			[/"/, { token: 'identifier.quote', next: '@pop' }],
		],
		backtickIdentifier: [
			[/[^`]+/, 'identifier'],
			[/`/, { token: 'identifier.quote', next: '@pop' }],
		],
	},
};

// Token colors keyed to VSCode's Dark Modern / Light Modern palettes. Theme rule
// matching is by token-type prefix, so `comment` also covers `comment.quote`, and
// `identifier` covers `identifier.quote`.
const DARK_RULES: monaco.editor.ITokenThemeRule[] = [
	{ token: 'keyword', foreground: '569CD6' },
	{ token: 'type', foreground: '4EC9B0' },
	{ token: 'predefined', foreground: 'DCDCAA' },
	{ token: 'string', foreground: 'CE9178' },
	{ token: 'number', foreground: 'B5CEA8' },
	{ token: 'comment', foreground: '6A9955' },
	{ token: 'operator', foreground: 'D4D4D4' },
	{ token: 'delimiter', foreground: 'CCCCCC' },
	{ token: 'identifier', foreground: 'CCCCCC' },
];

const LIGHT_RULES: monaco.editor.ITokenThemeRule[] = [
	{ token: 'keyword', foreground: '0000FF' },
	{ token: 'type', foreground: '267F99' },
	{ token: 'predefined', foreground: '795E26' },
	{ token: 'string', foreground: 'A31515' },
	{ token: 'number', foreground: '098658' },
	{ token: 'comment', foreground: '008000' },
	{ token: 'operator', foreground: '000000' },
	{ token: 'delimiter', foreground: '3B3B3B' },
	{ token: 'identifier', foreground: '3B3B3B' },
];

/** The bits of a theme the editor needs to paint itself (a structural subset of ThemeDef,
 *  declared locally so this module doesn't import theme.ts and create an import cycle). */
interface EditorTheme {
	id: string;
	base: 'dark' | 'light';
	editorBg: string;
	editorFg: string;
	/** Optional per-theme syntax-token color override; falls back to the base rule set. */
	editorRules?: monaco.editor.ITokenThemeRule[];
}

let registered = false;
/** The driver whose extra words are currently coloured, so the same one is not re-applied. */
let dialectDriverId: string | undefined;

/**
 * Colour the words THIS vendor adds: `PREWHERE`, `FINAL`, `ARRAY JOIN`, `UInt64`, `LowCardinality`.
 *
 * One tokenizer serves the whole editor rather than a language id per vendor, because the language
 * features (completion, hover, folding) are all registered against `sql` and already follow the
 * active connection the same way. Re-setting the provider re-tokenizes the open models, so this is
 * called when the active connection changes and is a no-op when the vendor has not.
 */
export function setSqlDialect(driverId: string | undefined): void {
	if (!registered || driverId === dialectDriverId) {
		return;
	}
	dialectDriverId = driverId;
	applyTokenizer();
}

/** Install the tokenizer with the active dialect's extra keywords and type names folded in. */
function applyTokenizer(): void {
	const dialect = dialectFor(dialectDriverId);
	// A multi-word keyword ("ARRAY JOIN") colours a word at a time: the tokenizer matches one
	// identifier at a time, so each half has to be in the list by itself.
	const extraKeywords = (dialect.keywords ?? []).flatMap((keyword) => keyword.split(/\s+/));
	monaco.languages.setMonarchTokensProvider('sql', {
		...language,
		keywords: [...KEYWORDS, ...extraKeywords],
		builtinTypes: [...TYPES, ...(dialect.typeNames ?? [])],
	});
}

/** Install the SQL tokenizer + one named Monaco theme per registered app theme (idempotent,
 *  process-global). Each Monaco theme is named `snout-<id>` and inherits the light or dark
 *  token colors from the theme's base, with the theme's own editor surface colors. */
export function registerSqlHighlighting(themes: EditorTheme[]): void {
	if (registered) {
		return;
	}
	registered = true;
	applyTokenizer();
	for (const t of themes) {
		monaco.editor.defineTheme(`snout-${t.id}`, {
			base: t.base === 'light' ? 'vs' : 'vs-dark',
			inherit: true,
			rules: t.editorRules ?? (t.base === 'light' ? LIGHT_RULES : DARK_RULES),
			colors: { 'editor.background': t.editorBg, 'editor.foreground': t.editorFg },
		});
	}
}
