/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { awsConfigPaths, discoverAwsProfiles, parseAwsIni } from './config';

/** A fake home with an `.aws` directory in it, so discovery is tested against real files. */
function withHome(files: { config?: string; credentials?: string }, fn: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), 'awshome-'));
	try {
		mkdirSync(join(home, '.aws'), { recursive: true });
		if (files.config !== undefined) {
			writeFileSync(join(home, '.aws', 'config'), files.config, 'utf8');
		}
		if (files.credentials !== undefined) {
			writeFileSync(join(home, '.aws', 'credentials'), files.credentials, 'utf8');
		}
		fn(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe('parseAwsIni', () => {
	test('sections and keys, with the case folded the way AWS folds it', () => {
		const parsed = parseAwsIni('[default]\nRegion = eu-west-1\n');
		assert.deepEqual(parsed, { default: { region: 'eu-west-1' } });
	});

	test('comments end a line, and a # inside a value does not', () => {
		const parsed = parseAwsIni([
			'# a leading comment',
			'[dev]  ; trailing on the header',
			'region = us-east-1 # and here',
			'credential_process = /usr/bin/creds --tag a#b',
		].join('\n'));
		// The comment character only bites at a start or after whitespace, which is AWS's own rule.
		assert.equal(parsed.dev.region, 'us-east-1');
		assert.equal(parsed.dev.credential_process, '/usr/bin/creds --tag a#b');
	});

	test('a value may contain =, so only the FIRST one splits', () => {
		const parsed = parseAwsIni('[dev]\ncredential_process = sh -c "echo a=b"\n');
		assert.equal(parsed.dev.credential_process, 'sh -c "echo a=b"');
	});

	test('INDENTED sub-properties are dropped, not flattened into the profile', () => {
		// Letting these through would put `max_concurrent_requests` in the profile as though the user
		// had set it there, and `addressing_style` is one keystroke from something we do read.
		const parsed = parseAwsIni([
			'[profile dev]',
			'region = eu-west-1',
			's3 =',
			'    max_concurrent_requests = 20',
			'    addressing_style = path',
			'output = json',
		].join('\n'));
		assert.deepEqual(parsed['profile dev'], { region: 'eu-west-1', s3: '', output: 'json' });
	});

	test('CRLF, blank lines and a repeated section all survive', () => {
		const parsed = parseAwsIni('[a]\r\nregion = x\r\n\r\n[a]\r\nfoo = y\r\n');
		assert.deepEqual(parsed.a, { region: 'x', foo: 'y' });
	});

	test('a key before any section is ignored rather than crashing', () => {
		assert.deepEqual(parseAwsIni('region = nowhere\n[a]\nregion = x\n'), { a: { region: 'x' } });
	});
});

describe('discoverAwsProfiles', () => {
	test('[profile x] in config and [x] in credentials are the SAME profile', () => {
		// The classic bug is a profile called "profile dev" that `fromIni` has never heard of.
		withHome({
			config: '[default]\nregion = eu-west-1\n\n[profile dev]\nregion = us-east-1\n',
			credentials: '[dev]\naws_access_key_id = AKIADEV\naws_secret_access_key = shhh\n',
		}, (home) => {
			const profiles = discoverAwsProfiles({}, home);
			assert.deepEqual(profiles.map((p) => p.name), ['default', 'dev']);
			assert.equal(profiles[1].region, 'us-east-1', 'the region comes from config');
			assert.equal(profiles[1].kind, 'key', 'the credential kind comes from credentials');
		});
	});

	test('NO SECRET is read, ever', () => {
		// The whole point of importing a profile NAME rather than its key. Asserted on the returned
		// value because that is what crosses IPC.
		withHome({
			credentials: '[dev]\naws_access_key_id = AKIADEV\naws_secret_access_key = super-secret\n',
		}, (home) => {
			assert.doesNotMatch(JSON.stringify(discoverAwsProfiles({}, home)), /super-secret/);
		});
	});

	test('each credential kind is recognised, and the ones with a catch say so', () => {
		withHome({
			config: [
				'[profile keyed]',
				'region = eu-west-1',
				'[profile ssoish]',
				'sso_session = corp',
				'sso_account_id = 1234',
				'[profile assumed]',
				'role_arn = arn:aws:iam::1234:role/x',
				'source_profile = keyed',
				'[profile shelled]',
				'credential_process = /usr/bin/creds',
				'[profile nothing]',
				'output = json',
				'[sso-session corp]',
				'sso_region = eu-west-1',
			].join('\n'),
			credentials: '[keyed]\naws_access_key_id = AKIA\n',
		}, (home) => {
			const by = new Map(discoverAwsProfiles({}, home).map((p) => [p.name, p]));
			assert.equal(by.get('keyed')?.kind, 'key');
			assert.equal(by.get('ssoish')?.kind, 'sso');
			assert.equal(by.get('assumed')?.kind, 'role');
			assert.equal(by.get('shelled')?.kind, 'process');
			assert.equal(by.get('nothing')?.kind, 'unknown');
			// An SSO session is not a profile and must not be offered as one.
			assert.equal(by.has('corp'), false);
			assert.equal(by.has('sso-session corp'), false);

			// The half a user cannot see for themselves, and the half that decides whether a
			// SCHEDULED flow still works in the morning.
			assert.match(by.get('ssoish')?.note ?? '', /scheduled flow stops when it expires/);
			assert.equal(by.get('keyed')?.note, undefined, 'a key pair has no catch to warn about');
		});
	});

	test('a profile in only one of the two files is still a profile', () => {
		withHome({ credentials: '[only-here]\naws_access_key_id = AKIA\n' }, (home) => {
			assert.deepEqual(discoverAwsProfiles({}, home).map((p) => p.name), ['only-here']);
		});
		withHome({ config: '[profile only-there]\nregion = eu-west-1\n' }, (home) => {
			assert.deepEqual(discoverAwsProfiles({}, home).map((p) => p.name), ['only-there']);
		});
	});

	test('default sorts first, then the rest alphabetically', () => {
		withHome({ config: '[profile zed]\n[default]\n[profile alpha]\n' }, (home) => {
			assert.deepEqual(discoverAwsProfiles({}, home).map((p) => p.name), ['default', 'alpha', 'zed']);
		});
	});

	test('no AWS config at all is an empty list, not a throw', () => {
		const home = mkdtempSync(join(tmpdir(), 'awshome-'));
		try {
			assert.deepEqual(discoverAwsProfiles({}, home), []);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('the environment variables that move those files are honoured', () => {
		// A user with AWS_CONFIG_FILE set has it set for a reason, and reading the default path
		// anyway would offer them profiles they are not using.
		const paths = awsConfigPaths({ AWS_CONFIG_FILE: '/somewhere/cfg', AWS_SHARED_CREDENTIALS_FILE: '/somewhere/creds' }, '/home/x');
		assert.deepEqual(paths, { config: '/somewhere/cfg', credentials: '/somewhere/creds' });
		assert.match(awsConfigPaths({}, '/home/x').config, /[\\/]home[\\/]x[\\/]\.aws[\\/]config$/);
	});
});
