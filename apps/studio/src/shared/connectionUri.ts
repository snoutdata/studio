/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A connection string with a password in it is a secret, wherever it is kept.
//
// MongoDB's connection mode takes a whole `mongodb://user:password@host/...` URI in the Host field,
// and until 2026-10-14 that string was saved as typed: the password sat in plaintext in
// connections.json, and `get_connection` handed it to the model. So a URI's password is lifted out
// on save (main), kept in the keychain like any other connection password, and put back into the
// URI only where the driver connects. The stored URI keeps its user name, so the database it
// authenticates against and every option still mean what they meant.
//
// Mongo is the only driver whose Host field is a connection string; every other driver takes a
// host name and separate credential fields. A URL with a password pasted into one of those Host
// fields (a Postgres URL, `https://user:password@clickhouse`) does not connect,
// but it would be saved all the same, so its password is lifted out the same way. Only Mongo's is
// put back. `maskUriPasswords` is for every surface a model or an agent reads, whatever the scheme.
//
// Pure: no Node, no Electron, so main, the server child and the renderer share it.

/**
 * The parts of a `mongodb://` / `mongodb+srv://` URI's authority, split the way the official
 * driver's parser (mongodb-connection-string-url) splits it: the user name holds no `:` or `@`, the
 * password no `@`.
 */
const MONGO_USERINFO = /^(mongodb(?:\+srv)?:\/\/)(?:([^:@]*)(?::([^@]*))?@)?([\s\S]*)$/i;

/** Any other `scheme://user:password@host` URL: user info ends at the first `/`, `?` or `#`. */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)(?:([^:@/?#]*)(?::([^@/?#]*))?@)?([\s\S]*)$/i;

/** Whether `host` is a Mongo connection string rather than a host name. */
export function isMongoUri(host: string): boolean {
	return /^mongodb(?:\+srv)?:\/\//i.test(host.trim());
}

function decode(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

/**
 * A connection string with its password taken out, and the password (decoded), or the string
 * unchanged and no password when it carries none. The user name stays; an empty user name leaves
 * no user info at all. Anything that is not a `scheme://` URL is returned as it is.
 */
export function splitUriPassword(host: string): { host: string; password?: string } {
	const match = (isMongoUri(host) ? MONGO_USERINFO : URL_USERINFO).exec(host.trim());
	if (!match || match[3] === undefined) {
		return { host };
	}
	const [, scheme, user = '', password, rest] = match;
	const stripped = `${scheme}${user ? `${user}@` : ''}${rest}`;
	return password === '' ? { host: stripped } : { host: stripped, password: decode(password) };
}

/**
 * The URI the driver connects with: the saved password put back after the user name, encoded so a
 * `:`, `@` or `/` in it cannot change what the URI says. Unchanged when there is no password, no
 * user name to attach it to, or the URI already carries one (a connection saved before passwords
 * were lifted out, until the startup migration has run).
 */
export function injectUriPassword(uri: string, password: string | undefined): string {
	// X.509 and OIDC take no password, and the driver refuses one.
	if (!password || !isMongoUri(uri) || /[?&]authMechanism=(?:MONGODB-X509|MONGODB-OIDC)\b/i.test(uri)) {
		return uri;
	}
	const match = MONGO_USERINFO.exec(uri.trim());
	if (!match || match[2] === undefined || match[2] === '' || match[3] !== undefined) {
		return uri;
	}
	const [, scheme, user, , rest] = match;
	return `${scheme}${user}:${encodeURIComponent(password)}@${rest}`;
}

/** Whether a Mongo URI carries user info (a user name, with or without a password). */
export function uriHasUserinfo(uri: string): boolean {
	if (!isMongoUri(uri)) {
		return false;
	}
	const match = MONGO_USERINFO.exec(uri.trim());
	return Boolean(match && match[2] !== undefined);
}

export const MASKED_PASSWORD = '****';

/**
 * `text` with the password of every `scheme://user:password@` in it replaced by
 * {@link MASKED_PASSWORD}, any scheme. For what a model, an agent or the audit log is shown.
 */
export function maskUriPasswords(text: string): string {
	return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@"'`<>]*):[^\s@"'`<>]*@/gi, `$1:${MASKED_PASSWORD}@`);
}

/**
 * A connection about to be saved or tested, with a password in its Host field's connection string
 * moved to its password: the one the URI carries wins over the Password field, since the Mongo
 * driver has always used the URI's own credentials over the form's.
 */
export function liftUriPassword<T extends { host: string; password?: string }>(form: T): T {
	if (typeof form.host !== 'string') {
		return form;
	}
	const split = splitUriPassword(form.host);
	if (split.password === undefined) {
		return split.host === form.host ? form : { ...form, host: split.host };
	}
	return { ...form, host: split.host, password: split.password };
}
