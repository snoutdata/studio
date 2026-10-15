/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lstatSync } from 'node:fs';

import type { ConnectionConfig } from '../shared/connection';
import type { ConnectionFormValues } from '../shared/forms';
import { flavorForImportText } from '../shared/engine';

// Helpers shared by the connection importers (DBeaver / DataGrip / Navicat). Each importer
// reads a different on-disk format but resolves to the same ConnectionFormValues, so the
// driver mapping, default ports, JDBC-URL fallback, environment labels, duplicate detection
// and secret stripping live here once. A tiny XML reader is included for the XML-based tools.

/**
 * What a walk of another tool's folder may do with one entry: descend into a directory, take a
 * regular file, or skip it (undefined). Judged with `lstat`, so a link is never followed: a `.sql`
 * linked to `~/.aws/credentials`, or a folder linked to the home folder, is skipped. Anything that
 * is neither a file nor a directory (a FIFO, a socket, a device) is skipped too, since reading one
 * can block or return what was never a file.
 */
export function walkEntry(full: string): 'dir' | 'file' | undefined {
	try {
		const stat = lstatSync(full);
		return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined;
	} catch {
		return undefined;
	}
}

/** Default port per driver, used when the source omits one. */
export const DEFAULT_PORT: Record<string, number> = {
	'mysql-aurora': 3306, mariadb: 3306, postgres: 5432, sqlserver: 1433, oracle: 1521, db2: 50000,
	redshift: 5439, hana: 30015, clickhouse: 8123,
};

/**
 * Map any blob of provider/driver/url/type text to one of our driver ids (null = no
 * equivalent). Callers pass whatever identifying strings they have joined together.
 */
export function mapDriver(text: string): string | null {
	const hay = text.toLowerCase();
	// A wire-compatible engine (CockroachDB, TiDB, ...) connects through its base driver; the
	// flavor itself is read by `mapFlavor`. Checked first, since TiDB's text never says "mysql".
	const flavor = flavorForImportText(hay);
	if (flavor) {
		return flavor.baseDriver;
	}
	// MariaDB is its own driver; match it before the generic MySQL check (a MariaDB driver
	// class often also contains "mysql").
	if (hay.includes('mariadb')) {
		return 'mariadb';
	}
	if (hay.includes('mysql') || hay.includes('aurora')) {
		return 'mysql-aurora';
	}
	// Redshift is its own driver (its catalog is not Postgres's); match it before the generic
	// Postgres check, since a Redshift JDBC URL is often "jdbc:redshift://" AND names postgresql.
	if (hay.includes('redshift')) {
		return 'redshift';
	}
	if (hay.includes('postgres') || hay.includes('greenplum')) {
		return 'postgres';
	}
	if (hay.includes('sqlserver') || hay.includes('mssql') || hay.includes('microsoft') || hay.includes('ms_sql') || hay.includes('sql server')) {
		return 'sqlserver';
	}
	if (hay.includes('oracle')) {
		return 'oracle';
	}
	if (hay.includes('db2')) {
		return 'db2';
	}
	if (hay.includes('clickhouse')) {
		return 'clickhouse';
	}
	if (hay.includes('hana') || hay.includes('hdb') || hay.includes('saphana')) {
		return 'hana';
	}
	return null;
}

/** The wire-compatible engine an imported connection names, if any (see `mapDriver`). */
export function mapFlavor(text: string): string | undefined {
	return flavorForImportText(text)?.id;
}

/** Map a tool's environment/type id to our environment labels. */
export function mapEnvironment(type: unknown): string | undefined {
	if (typeof type !== 'string') {
		return undefined;
	}
	const t = type.toLowerCase();
	if (t === 'dev' || t === 'development') {
		return 'dev';
	}
	if (t === 'prod' || t === 'production') {
		return 'prod';
	}
	if (t === 'stage' || t === 'staging' || t === 'test' || t === 'qa') {
		return 'stage';
	}
	return undefined;
}

/** Pull host/port/database out of a `jdbc:...://host:port/db?...` URL as a fallback. */
export function parseJdbcUrl(url: unknown): { host?: string; port?: number; database?: string } {
	if (typeof url !== 'string') {
		return {};
	}
	const match = /\/\/([^:/?]+)(?::(\d+))?(?:\/([^?;]+))?/.exec(url);
	if (!match) {
		return {};
	}
	return {
		host: match[1] || undefined,
		port: match[2] ? Number(match[2]) : undefined,
		database: match[3] || undefined,
	};
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** `localhost` and `127.0.0.1` are one host: a local project saves one, discovery reports the other. */
function sameHost(a: string, b: string): boolean {
	const x = a.trim().toLowerCase();
	const y = b.trim().toLowerCase();
	return x === y || (LOOPBACK.has(x) && LOOPBACK.has(y));
}

/**
 * Is this database already a saved connection? (so we can pre-uncheck dupes, and discovery can leave
 * it out). The same server and database is the same database whoever signs in: a tool that saved it
 * as another user, or with no user at all, is not offering anything new.
 */
export function matchesExisting(existing: ConnectionConfig[], values: ConnectionFormValues): boolean {
	return existing.some((c) =>
		c.driver === values.driver &&
		sameHost(c.host, values.host) &&
		c.port === values.port &&
		(c.database ?? '') === (values.database ?? ''));
}

/** Drop secrets from a value set before it leaves the main process for the renderer. */
export function stripSecrets(values: ConnectionFormValues): ConnectionFormValues {
	const clean: ConnectionFormValues = { ...values, password: undefined };
	if (clean.ssh) {
		clean.ssh = { ...clean.ssh, password: undefined, passphrase: undefined };
	}
	return clean;
}

// --- Minimal XML reading (DataGrip / Navicat) ---------------------------------------
//
// The XML we read is shallow, attribute-heavy config (no namespaces, no CDATA we care
// about), so a real parser would be overkill and an extra dependency. These helpers pull
// out elements and attributes by name with a small, well-scoped regex pass.

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the handful of XML entities config files actually use. */
export function decodeXml(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return XML_ENTITIES[body] ?? whole;
	});
}

/** One parsed XML element: its attributes and its raw inner XML. */
export interface XmlElement {
	attrs: Record<string, string>;
	inner: string;
}

/** Parse an element's attribute string (`a="1" b="2"`) into a decoded record. */
function parseAttrs(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) {
		attrs[m[1]] = decodeXml(m[2]);
	}
	return attrs;
}

/**
 * Find every `<tag …>…</tag>` and self-closing `<tag …/>` for `tag`, returning each
 * element's attributes and inner text. Not nesting-aware for same-named nesting, which the
 * config formats we read don't use.
 */
export function findElements(xml: string, tag: string): XmlElement[] {
	const out: XmlElement[] = [];
	const re = new RegExp(`<${tag}\\b([^>]*?)(/?)>`, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		const attrs = parseAttrs(m[1]);
		if (m[2] === '/') {
			out.push({ attrs, inner: '' });
			continue;
		}
		const close = xml.indexOf(`</${tag}>`, re.lastIndex);
		const inner = close === -1 ? '' : xml.slice(re.lastIndex, close);
		out.push({ attrs, inner });
	}
	return out;
}

/** Text content of the first `<tag>…</tag>` inside `xml` (decoded), or undefined. */
export function firstElementText(xml: string, tag: string): string | undefined {
	const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
	return m ? decodeXml(m[1].trim()) || undefined : undefined;
}

// --- A nesting-aware XML tree (MySQL Workbench, SSMS, property lists) ----------------
//
// `findElements` above is a flat regex pass, which is right for DataGrip and Navicat and wrong
// for the formats whose values NEST under one repeated tag: a Workbench `<value>` dict holds more
// `<value>`s, SSMS wraps everything in `<Element>`, and a plist `<dict>` holds `<dict>`s. This is
// still not a real parser (no namespaces, no DTD, no entities beyond the five), but it builds a
// tree, and a mismatched close tag unwinds to the element it names instead of throwing.

export interface XmlNode {
	name: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	/** The node's own text (decoded, concatenated, not trimmed). */
	text: string;
}

function parseAttrsQuoted(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) {
		attrs[m[1]] = decodeXml(m[2] ?? m[3] ?? '');
	}
	return attrs;
}

/** Parse XML text into a tree under a synthetic `#document` root. Never throws. */
export function parseXmlTree(xml: string): XmlNode {
	const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
	const stack: XmlNode[] = [root];
	const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		const top = stack[stack.length - 1];
		if (m[1] !== undefined) {
			top.text += m[1];
		} else if (m[2] !== undefined) {
			const at = stack.map((n) => n.name).lastIndexOf(m[2]);
			if (at > 0) {
				stack.length = at;
			}
		} else if (m[3] !== undefined) {
			const node: XmlNode = { name: m[3], attrs: parseAttrsQuoted(m[4] ?? ''), children: [], text: '' };
			top.children.push(node);
			if (m[5] !== '/') {
				stack.push(node);
			}
		} else if (m[6] !== undefined) {
			top.text += decodeXml(m[6]);
		}
	}
	return root;
}

/** Every descendant of `node` named `name`, depth first, not descending into a match. */
export function xmlDescendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
	for (const child of node.children) {
		if (child.name === name) {
			out.push(child);
		} else {
			xmlDescendants(child, name, out);
		}
	}
	return out;
}

/** The first direct child named `name`. */
export function xmlChild(node: XmlNode, name: string): XmlNode | undefined {
	return node.children.find((c) => c.name === name);
}

/** Trimmed text of the first descendant named `name`, or undefined when absent or blank. */
export function xmlText(node: XmlNode, name: string): string | undefined {
	const found = xmlDescendants(node, name)[0];
	const text = found?.text.trim();
	return text ? text : undefined;
}
