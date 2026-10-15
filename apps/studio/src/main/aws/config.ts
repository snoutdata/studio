/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';



/*---------------------------------------------------------------------------------------------
 *  The AWS CLI's own configuration, read so a user does not have to re-type what it already knows.
 *
 *  THE DECISION THAT SHAPES THIS FILE: we read the config to find out WHICH PROFILES EXIST and what
 *  region each one uses. We do NOT copy anybody's secret access key out of it, and there is no code
 *  here that reads one.
 *
 *  Referencing a profile by name is strictly better than copying its key, in three ways that all
 *  matter: the credential stays in the one place its owner manages, it keeps working when they
 *  rotate it, and an SSO or role-based profile has no key to copy in the first place. `fromIni`
 *  (already wired in `credentials.ts`) resolves it at call time, which is the same thing the `aws`
 *  command does.
 *
 *  The parser is exported and pure so it can be tested against the awkward real-world files
 *  (comments, `[profile x]` versus `[x]`, indented sub-properties, CRLF) rather than the tidy one
 *  everybody writes in an example.
 *--------------------------------------------------------------------------------------------*/

/** What kind of credential an AWS CLI profile carries, in the order AWS itself resolves them. */
export type AwsCredentialKind = 'key' | 'sso' | 'role' | 'process' | 'webIdentity' | 'unknown';

/**
 * A profile the AWS CLI already has on this computer.
 *
 * Main-side and AWS-shaped on purpose: the S3 driver turns one of these into the shared,
 * provider-neutral `ImportableCredential`, so nothing above the driver learns what an AWS profile
 * is. Note what is NOT on it and never will be: a secret.
 */
export interface AwsCliProfile {
	name: string;
	/** From `~/.aws/config`. Absent when the profile sets none, which is legal and common. */
	region?: string;
	kind: AwsCredentialKind;
	/** What this kind means when nobody is at the computer to sign in again, when it means anything. */
	note?: string;
}

/** One `[section]` from an AWS ini file: its top-level keys only. */
export type IniSections = Record<string, Record<string, string>>;

/**
 * Parse an AWS ini file.
 *
 * Not a general ini parser, and the differences are all things the real files do:
 *
 * - `#` and `;` start a comment, at the start of a line or after it.
 * - An INDENTED line is a sub-property of the key above it (`s3 =` then `  max_concurrent = 20`).
 *   Those are skipped rather than flattened: nothing here needs one, and letting them land as
 *   top-level keys would put `max_concurrent` in a profile as though the user had set it there.
 * - A value may legitimately contain `=` (a `credential_process` command line), so the split is on
 *   the FIRST one only.
 * - Keys are lower-cased; AWS treats them case-insensitively and a hand-edited file will not.
 */
export function parseAwsIni(text: string): IniSections {
	const sections: IniSections = {};
	let current: Record<string, string> | undefined;
	for (const raw of text.split(/\r?\n/)) {
		// A comment character only starts a comment at the start of a line or after whitespace, so a
		// value like `foo#bar` survives. AWS's own parser is this forgiving.
		const line = raw.replace(/(^|\s)[#;].*$/, '').trimEnd();
		if (line.trim().length === 0) {
			continue;
		}
		const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
		if (header) {
			const name = header[1].trim();
			current = sections[name] ?? (sections[name] = {});
			continue;
		}
		// Indented: a sub-property of the key above. See the note above for why it is dropped.
		if (/^\s/.test(line)) {
			continue;
		}
		const eq = line.indexOf('=');
		if (eq === -1 || !current) {
			continue;
		}
		current[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
	}
	return sections;
}

/** Where the AWS CLI keeps its two files, honouring the environment variables that move them. */
export function awsConfigPaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): { config: string; credentials: string } {
	return {
		config: env.AWS_CONFIG_FILE || join(home, '.aws', 'config'),
		credentials: env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials'),
	};
}

/**
 * A section name from `config` as a profile name.
 *
 * `config` writes `[profile dev]` and, for the default one only, `[default]`. `credentials` writes
 * `[dev]` for everything. Getting this backwards is the classic bug: you end up with a profile
 * called "profile dev" that `fromIni` has never heard of.
 */
function profileNameFromConfig(section: string): string | null {
	if (section === 'default') {
		return 'default';
	}
	const match = /^profile\s+(.+)$/.exec(section);
	return match ? match[1].trim() : null;
}

/** What kind of credential a profile carries, in the order AWS itself resolves them. */
function credentialKind(fields: Record<string, string>): AwsCredentialKind {
	if (fields.aws_access_key_id) {
		return 'key';
	}
	if (fields.sso_session || fields.sso_start_url) {
		return 'sso';
	}
	if (fields.role_arn) {
		return 'role';
	}
	if (fields.credential_process) {
		return 'process';
	}
	if (fields.web_identity_token_file) {
		return 'webIdentity';
	}
	return 'unknown';
}

/**
 * What each kind means when nobody is at the computer to sign in again, said plainly: the half a
 * user cannot see for themselves. An SSO profile is perfect at a desk and expires overnight.
 */
const KIND_NOTE: Record<AwsCredentialKind, string | undefined> = {
	key: undefined,
	sso: 'Signed in through SSO. It works while your session lasts, and a scheduled flow stops when it expires until you sign in again.',
	role: 'Assumes a role. It works wherever the profile it is based on does.',
	process: 'Runs a command of yours to fetch credentials. It works here as long as that command does.',
	webIdentity: 'Uses a web identity token file.',
	unknown: 'This profile names no credentials of its own, so it may rely on something else on this computer.',
};

/**
 * Every profile the AWS CLI knows about on this computer.
 *
 * Merged across both files the way AWS merges them: `credentials` wins for credential fields,
 * `config` supplies the region and everything else. A profile in only one of the two is still a
 * profile, which is the common case for both files.
 */
export function discoverAwsProfiles(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): AwsCliProfile[] {
	const paths = awsConfigPaths(env, home);
	const merged = new Map<string, Record<string, string>>();

	const read = (path: string): IniSections => {
		if (!existsSync(path)) {
			return {};
		}
		try {
			return parseAwsIni(readFileSync(path, 'utf8'));
		} catch {
			// Unreadable is empty. A permission error on one file must not stop the other being
			// offered, and it must certainly not stop the page opening.
			return {};
		}
	};

	for (const [section, fields] of Object.entries(read(paths.config))) {
		const name = profileNameFromConfig(section);
		if (name) {
			merged.set(name, { ...fields });
		}
	}
	for (const [section, fields] of Object.entries(read(paths.credentials))) {
		// `[sso-session x]` is not a profile, and it only ever appears in `config`; a section in
		// `credentials` is always a profile name verbatim.
		merged.set(section, { ...(merged.get(section) ?? {}), ...fields });
	}

	return [...merged.entries()]
		.map(([name, fields]) => {
			const kind = credentialKind(fields);
			return {
				name,
				region: fields.region || undefined,
				kind,
				note: KIND_NOTE[kind],
			} satisfies AwsCliProfile;
		})
		// `default` first, then alphabetical: it is the one most people mean.
		.sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name)));
}
