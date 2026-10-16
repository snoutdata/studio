/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { LocalService, LocalSetupForm } from '../../shared/localStack';
import {
	APP_OVERRIDE, apiErrorMessage, apiPathAllowed, applyEnv, dataApiOn, withProfile, composeProject, envFor, envForSettings, envValue, publicUrlProblem, evaluateRequirements, formProblem, parseDockerPs, parseEnv,
	projectState, settingsFromEnv, slugify, stackImageFrom, composeVocabulary, envKey, STACK_IMAGE, suggestPort, versionAtLeast, type EngineFacts,
	apiKey, exportName, restoreScript, restoreSwapSql, isExportName, mailEnv, mailTemplateProblem, memoryMb, overrideStale, ownerPasswordSql,
	downloadStack, STACK_COMMIT, STACK_FILES, STACK_SOURCE, stackFileProblem,
	keyRoles, rotatedKeys, scramVerifier, secretNameProblem, secretNames, secretValueProblem, settingsProblem, withSecret,
} from './plan';

// Local projects: what the wizard writes into .env, what the requirements say, and what
// `docker ps` means. The stack itself is the published one; these are the app's only decisions.

const INIT = `# Written by \`snout-stack init\`. Every value was made for this stack alone.

# Optional parts of the stack.
COMPOSE_PROFILES=objects,images

# The project's ref.
SNOUT_REF=abcdefghijklm

# Where clients reach the gateway.
API_EXTERNAL_URL=http://localhost:8000

SITE_URL=http://localhost:3000

ANON_KEY=eyJ.anon.sig

POSTGRES_OWNER_PASSWORD=pw123
`;

function form(over: Partial<LocalSetupForm> = {}): LocalSetupForm {
	return {
		name: "My App",
		folder: '/home/me/SnoutData/my-app',
		apiPort: 8001,
		dbPort: 54322,
		exposeApi: false,
		siteUrl: 'http://localhost:5173',
		autoconfirm: true,
		disableSignup: false,
		bundledStorage: true,
		images: true,
		addConnection: true,
		...over,
	};
}

test('applyEnv rewrites a name where it stands and keeps the comments init wrote', () => {
	const out = applyEnv(INIT, { API_EXTERNAL_URL: 'http://localhost:8001', SITE_URL: undefined });
	assert.match(out, /# Where clients reach the gateway\.\nAPI_EXTERNAL_URL=http:\/\/localhost:8001\n/);
	assert.match(out, /SITE_URL=http:\/\/localhost:3000/);
	assert.equal(out.match(/API_EXTERNAL_URL=/g)?.length, 1);
});

test('applyEnv appends a new name once, under one marker, and a second write updates it in place', () => {
	const once = applyEnv(INIT, { API_PORT: '8001', DB_PORT: '54322' });
	assert.equal(once.match(/# Set by the SnoutData desktop app\./g)?.length, 1);
	const twice = applyEnv(once, { API_PORT: '8002', SMTP_HOST: 'smtp.example.com' });
	assert.equal(twice.match(/# Set by the SnoutData desktop app\./g)?.length, 1);
	assert.equal(parseEnv(twice).get('API_PORT'), '8002');
	assert.equal(parseEnv(twice).get('SMTP_HOST'), 'smtp.example.com');
	assert.equal(twice.match(/API_PORT=/g)?.length, 1);
});

test('a value round-trips through envValue and parseEnv, quotes, spaces and all', () => {
	for (const value of ['plain', 'My App Team', "it's", 'a "quoted" $thing', 'a # not a comment', '']) {
		const text = `X=${envValue(value)}\n`;
		assert.equal(parseEnv(text).get('X'), value, text);
	}
	assert.equal(parseEnv('X=value # a comment\n').get('X'), 'value');
});

test('envFor writes the ports into the URL, binds the API to this machine unless asked, and maps the profiles', () => {
	const env = envFor(form());
	assert.equal(env.API_EXTERNAL_URL, 'http://localhost:8001');
	assert.equal(env.API_PORT, '8001');
	assert.equal(env.API_BIND, '127.0.0.1');
	assert.equal(env.DB_BIND, '127.0.0.1');
	assert.equal(env.COMPOSE_PROFILES, 'objects,images,data-api');
	assert.equal(env.AUTH_MAILER_AUTOCONFIRM, 'true');
	assert.equal(env.SMTP_HOST, undefined);
	assert.equal(envFor(form({ exposeApi: true })).API_BIND, '0.0.0.0');
	assert.equal(envFor(form({ images: false })).COMPOSE_PROFILES, 'objects,data-api');
});

test('own S3 drops the bundled store and never asks the stack to make the bucket', () => {
	const env = envFor(form({ bundledStorage: false, images: false, s3: { endpoint: 'https://r2.example.com', bucket: 'b', region: '', accessKey: 'k', secretKey: 's' } }));
	assert.equal(env.COMPOSE_PROFILES, 'data-api');
	assert.equal(env.S3_CREATE_BUCKET, 'false');
	assert.equal(env.S3_REGION, 'us-east-1');
	assert.match(formProblem(form({ bundledStorage: false })) ?? '', /S3/);
});

test('formProblem refuses what compose would refuse later, in a sentence', () => {
	assert.equal(formProblem(form()), null);
	assert.match(formProblem(form({ name: ' ' })) ?? '', /name/);
	assert.match(formProblem(form({ apiPort: 80 })) ?? '', /1024/);
	assert.match(formProblem(form({ dbPort: 8001 })) ?? '', /different ports/);
	assert.match(formProblem(form({ siteUrl: 'localhost:3000' })) ?? '', /http/);
});

test('settings read back what the wizard wrote, and a change writes only what it names', () => {
	const env = parseEnv(applyEnv(INIT, envFor(form())));
	const settings = settingsFromEnv(env);
	assert.equal(settings.apiPort, 8001);
	assert.equal(settings.exposeApi, false);
	assert.equal(settings.autoconfirm, true);
	assert.equal(settings.smtpPassSet, false);
	assert.equal(settings.fileSizeLimitMb, 50);
	const change = envForSettings({ apiPort: 8100, smtpPass: '' });
	assert.equal(change.API_EXTERNAL_URL, 'http://localhost:8100');
	assert.equal(change.SMTP_PASS, undefined, 'an empty secret keeps the stored one');
	assert.equal(change.SITE_URL, undefined);
});

test('the init image is the one the compose file pins', () => {
	assert.equal(stackImageFrom('image: ${SNOUT_IMAGES:-ghcr.io/snoutdata}/snout-stack:0.1.0\n'), 'ghcr.io/snoutdata/snout-stack:0.1.0');
	assert.equal(stackImageFrom('image: ghcr.io/snoutdata/snout-stack:0.2.1\n'), 'ghcr.io/snoutdata/snout-stack:0.2.1');
	assert.equal(stackImageFrom('image: postgres:17\n'), null);
});

test("a project's gateway is spoken to in the names its own stack serves", () => {
	assert.equal(composeVocabulary('image: ${SNOUT_IMAGES:-ghcr.io/snoutdata}/snout-stack:0.1.4\n'), 'old');
	assert.equal(composeVocabulary('image: ${SNOUT_IMAGES:-ghcr.io/snoutdata}/snout-stack:0.1.6\n'), 'new');
	assert.equal(composeVocabulary(`image: ${STACK_IMAGE}\n`), 'new');
	assert.equal(composeVocabulary('image: ghcr.io/snoutdata/snout-stack:0.2.0\n'), 'new');
	// Unreadable, or a compose file of the user's own: a current stack.
	assert.equal(composeVocabulary(null), 'new');
	assert.equal(composeVocabulary('name: snout-stack\n'), 'new');
});

test('the stack is read from one pinned commit, and every file it starts with has a hash', () => {
	assert.match(STACK_COMMIT, /^[0-9a-f]{40}$/);
	assert.equal(STACK_SOURCE, `https://raw.githubusercontent.com/snoutdata/snout-stack/${STACK_COMMIT}`);
	assert.deepEqual(STACK_FILES.map((f) => f.path), ['compose.yaml', 'functions/hello/index.ts']);
	for (const file of STACK_FILES) {
		assert.match(file.sha256, /^[0-9a-f]{64}$/, file.path);
	}
});

test('a stack file is used only when its bytes are the pinned ones', () => {
	const bytes = new TextEncoder().encode('services: {}\n');
	const pinned = { path: 'compose.yaml', sha256: createHash('sha256').update(bytes).digest('hex') };
	assert.equal(stackFileProblem(pinned, bytes), null);
	const problem = stackFileProblem(pinned, new TextEncoder().encode('services: {evil: {}}\n'));
	assert.match(problem ?? '', /compose\.yaml is not the published snout-stack file/);
	assert.match(problem ?? '', /nothing was written or run/);
});

test('a download with a changed file is refused, and nothing else is fetched after it', async () => {
	const asked: string[] = [];
	const fake = (async (url: string) => {
		asked.push(url);
		return new Response('image: ghcr.io/snoutdata/snout-stack:0.1.4\n# changed\n');
	}) as unknown as typeof fetch;
	const result = await downloadStack(fake);
	assert.ok('problem' in result);
	assert.match(result.problem, /compose\.yaml is not the published snout-stack file/);
	assert.deepEqual(asked, [`${STACK_SOURCE}/compose.yaml`]);
});

test('a failed download says which file and why', async () => {
	const fake = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
	const result = await downloadStack(fake);
	assert.ok('problem' in result);
	assert.equal(result.problem, "Could not download the stack: compose.yaml: HTTP 404");
});

test('two projects never share a compose name', () => {
	assert.notEqual(composeProject('abcdefghijklm'), composeProject('nopqrstuvwxyz'));
	assert.equal(slugify("  My Ápp!! 2 "), 'my-app-2');
	assert.equal(slugify('!!!'), 'project');
});

test('suggestPort skips another project and a listener', () => {
	assert.equal(suggestPort(8000, new Set([8000]), (p) => p !== 8001), 8002);
});

test('compose versions compare as numbers, with the Desktop suffix ignored', () => {
	assert.ok(versionAtLeast('v2.29.1-desktop.1', '2.24.0'));
	assert.ok(versionAtLeast('2.24.0', '2.24.0'));
	assert.ok(!versionAtLeast('2.9.0', '2.24.0'));
	assert.ok(!versionAtLeast('garbage', '2.24.0'));
});

function facts(over: Partial<EngineFacts> = {}): EngineFacts {
	return {
		platform: 'win32',
		dockerPath: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
		desktopInstalled: true,
		info: { serverVersion: '27.3.1', operatingSystem: 'Docker Desktop', memTotal: 8 * 1024 ** 3 },
		composeVersion: '2.29.1',
		network: true,
		...over,
	};
}

test('requirements: everything met is ready', () => {
	const r = evaluateRequirements(facts());
	assert.ok(r.ready);
	assert.equal(r.engine, 'Docker Desktop');
	assert.ok(r.items.every((i) => i.status === 'ok'));
});

test('requirements: no docker stops at once and links the installer', () => {
	const r = evaluateRequirements(facts({ dockerPath: null }));
	assert.ok(!r.ready);
	assert.equal(r.items.length, 1);
	assert.match(r.items[0].link?.url ?? '', /docker-desktop/);
	assert.match(evaluateRequirements(facts({ dockerPath: null, platform: 'linux' })).items[0].link?.url ?? '', /engine\/install/);
});

test('requirements: Desktop installed but stopped offers to start it; a denied socket does not', () => {
	const stopped = evaluateRequirements(facts({ info: null, infoError: 'error during connect' }));
	const engine = stopped.items.find((i) => i.id === 'engine');
	assert.equal(engine?.status, 'fail');
	assert.equal(engine?.canStartEngine, true);
	const denied = evaluateRequirements(facts({ platform: 'linux', info: null, infoError: 'permission denied while trying to connect' }));
	assert.match(denied.items.find((i) => i.id === 'engine')?.advice ?? '', /docker group/);
	assert.ok(!denied.items.find((i) => i.id === 'engine')?.canStartEngine);
});

test('requirements: an old compose fails, little memory only warns', () => {
	const old = evaluateRequirements(facts({ composeVersion: '2.20.2' }));
	assert.equal(old.items.find((i) => i.id === 'compose')?.status, 'fail');
	assert.ok(!old.ready);
	const small = evaluateRequirements(facts({ info: { serverVersion: '27', operatingSystem: 'Docker Desktop', memTotal: 1024 ** 3 } }));
	assert.equal(small.items.find((i) => i.id === 'memory')?.status, 'warn');
	assert.ok(small.ready);
});

function ps(project: string, service: string, state: string, status: string, oneoff = 'False'): string {
	return JSON.stringify({ Labels: `com.docker.compose.project=${project},com.docker.compose.service=${service},com.docker.compose.oneoff=${oneoff}`, State: state, Status: status });
}

test('docker ps groups by project, reads health and exit codes, and skips one-off runs', () => {
	const out = [
		ps('snout-a', 'db', 'running', 'Up 2 minutes (healthy)'),
		ps('snout-a', 'setup', 'exited', 'Exited (0) 2 minutes ago'),
		ps('snout-a', 'functions-deploy', 'exited', 'Exited (0) 1 minute ago', 'True'),
		ps('snout-b', 'gateway', 'running', 'Up 5 seconds'),
		'not json',
		JSON.stringify({ Labels: { 'com.docker.compose.project': 'snout-c', 'com.docker.compose.service': 'db' }, State: 'running', Status: 'Up' }),
	].join('\n');
	const map = parseDockerPs(out);
	const a = map.get('snout-a') ?? [];
	assert.deepEqual(a.map((s) => s.name), ['db', 'setup']);
	assert.equal(a[0].health, 'healthy');
	assert.equal(a[1].exitCode, 0);
	assert.ok(a[1].oneShot);
	assert.equal(map.get('snout-c')?.[0].name, 'db', 'Podman writes Labels as an object');
});

test('project state: running, partial, starting, stopped', () => {
	const up = (name: string, health = ''): LocalService =>
		({ name, state: 'running', health, oneShot: false, exitCode: null });
	const core = ['db', 'auth', 'rest', 'metadata', 'storage', 'realtime', 'functions', 'gateway'];
	assert.equal(projectState(core.map((n) => up(n))), 'running');
	assert.equal(projectState([...core.slice(1).map((n) => up(n)), { name: 'db', state: 'exited', health: '', oneShot: false, exitCode: 1 }]), 'partial');
	assert.equal(projectState([up('db', 'starting'), ...core.slice(1).map((n) => up(n))]), 'starting');
	assert.equal(projectState([{ name: 'setup', state: 'exited', health: '', oneShot: true, exitCode: 0 }]), 'stopped');
	assert.equal(projectState([]), 'stopped');
});

test('the gateway is called only on the admin, storage and data paths, never off them', () => {
	for (const ok of ['/auth/v1/admin/users', '/auth/v1/admin/users/abc', '/storage/v1/bucket', '/storage/v1/object/b/a%20b.png', '/rest/v1/notes?select=*&limit=5']) {
		assert.ok(apiPathAllowed(ok), ok);
	}
	for (const bad of ['/auth/v1/token', '/functions/v1/x', 'http://evil/rest/v1/', '//evil/rest/v1/', '/rest/v1/../auth/v1/token', '/storage/v1/ x', 'rest/v1/notes', '/storage/v1\..']) {
		assert.ok(!apiPathAllowed(bad), bad);
	}
	// The same list under our names (shared/ownLayout.ts), which is how Studio writes them.
	for (const ok of ['/v1/identity/operator/people', '/v1/identity/operator/people/abc', '/v1/files/space', '/v1/files/file/b/a%20b.png', '/v1/data/notes?select=*&limit=5']) {
		assert.ok(apiPathAllowed(ok), ok);
	}
	for (const bad of ['/v1/identity/session', '/v1/identity/operator', '/v1/fn/x', '/v1/graph', 'http://evil/v1/data/', '/v1/data/../identity/session', '/v1/data/%2e%2e/%2e%2e/v1/fn/x', '/v1/files/a%2F..%2Fb']) {
		assert.ok(!apiPathAllowed(bad), bad);
	}
});

test('an encoded parent reference or slash cannot carry the service key off the allow-list', () => {
	// fetch resolves `%2e%2e` as `..`, so each of these would have reached a route outside the list.
	for (const bad of [
		'/rest/v1/%2e%2e/%2e%2e/functions/v1/x',
		'/rest/v1/%2E%2E/%2E%2E/auth/v1/token',
		'/storage/v1/.%2e/.%2e/auth/v1/token',
		'/rest/v1/%252e%252e/%252e%252e/functions/v1/x',
		'/rest/v1/%25252e%25252e/functions/v1/x',
		'/rest/v1/notes%2f..%2f..%2fauth',
		'/rest/v1/a%2F..%2Fb',
		'/rest/v1/a%5c..%5cb',
		'/rest/v1/a%5Cb',
		'/rest/v1/a%252f..%252fb',
		'/rest/v1/%2f%2fevil.example/x',
		'/rest/v1/./../../functions/v1/x',
	]) {
		assert.equal(apiPathAllowed(bad), false, bad);
	}
	// Legitimate encodings and query values still pass.
	for (const ok of ['/storage/v1/object/avatars/my%20photo.png', '/storage/v1/object/avatars/100%25.png', '/storage/v1/object/avatars/caf%C3%A9.png', '/rest/v1/notes?title=like.%25draft%25', '/auth/v1/admin/users?page=1&per_page=50']) {
		assert.equal(apiPathAllowed(ok), true, ok);
	}
});

test('a public address must be https off this machine and its network', () => {
	assert.equal(publicUrlProblem('https://api.example.com'), null);
	assert.equal(publicUrlProblem('http://localhost:8000'), null);
	assert.equal(publicUrlProblem('http://192.168.1.20:8000'), null);
	assert.equal(publicUrlProblem('http://mybox.local:8000'), null);
	assert.match(publicUrlProblem('http://api.example.com') ?? '', /https/);
	assert.match(publicUrlProblem('api.example.com') ?? '', /http/);
});

test('the public address follows the port only while it is still the local default', () => {
	const local = settingsFromEnv(parseEnv('API_PORT=8000\nAPI_EXTERNAL_URL=http://localhost:8000\n'));
	assert.equal(envForSettings({ apiPort: 8100 }, local).API_EXTERNAL_URL, 'http://localhost:8100');
	const published = settingsFromEnv(parseEnv('API_PORT=8000\nAPI_EXTERNAL_URL=https://api.example.com\n'));
	assert.equal(envForSettings({ apiPort: 8100 }, published).API_EXTERNAL_URL, undefined);
	assert.equal(envForSettings({ publicUrl: 'https://api.example.com/' }, local).API_EXTERNAL_URL, 'https://api.example.com');
	assert.equal(envForSettings({ clientAddressHeader: 'x-real-ip' }, local).GATEWAY_CLIENT_ADDRESS_HEADER, 'x-real-ip');
});

test('a service refusal reads as its own sentence, whichever key it used', () => {
	assert.equal(apiErrorMessage({ msg: 'User already registered' }, '', 422), 'User already registered');
	assert.equal(apiErrorMessage({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }, '', 400), 'The resource already exists');
	assert.equal(apiErrorMessage(null, '', 502), 'HTTP 502');
});

test('the data API switch is the rest profile, and only our own override is ours to change', () => {
	assert.equal(withProfile('objects,images', 'data-api', true), 'objects,images,data-api');
	assert.equal(withProfile('objects,data-api,images', 'data-api', false), 'objects,images');
	assert.equal(withProfile('', 'data-api', true), 'data-api');
	const env = (profiles: string): Map<string, string> => parseEnv(`COMPOSE_PROFILES=${profiles}\n`);
	assert.ok(dataApiOn(env('objects'), null), 'without the override rest has no profile and always runs');
	assert.ok(dataApiOn(env('objects,data-api'), APP_OVERRIDE));
	assert.ok(!dataApiOn(env('objects,images'), APP_OVERRIDE));
	assert.ok(dataApiOn(env('objects'), 'services:\n  rest:\n    image: mine\n'), 'a user override is not read as a switch');
	assert.match(envFor(form()).COMPOSE_PROFILES ?? '', /data-api/);
});

test('the API keys are signed as the stack signs them', () => {
	// Computed independently (Python's hmac) with keys.rs's claims in serde_json's sorted order.
	assert.equal(apiKey('a'.repeat(48), 'anon'), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjQxMDI0NDQ4MDAsImlhdCI6MCwiaXNzIjoic25vdXRkYXRhIiwicm9sZSI6ImFub24ifQ.k38-Chr2FHViKLCPnDQJz9iiRdUjRZ2pOn395Du3Koc');
	const keys = rotatedKeys();
	assert.ok(keys.JWT_SECRET.length >= 32);
	assert.equal(keys.ANON_KEY, apiKey(keys.JWT_SECRET, 'anon'), 'a .env that names no layout is an old-layout stack');
	assert.equal(keys.SERVICE_ROLE_KEY, apiKey(keys.JWT_SECRET, 'service_role'));
	assert.equal(keys.APP_KEY, undefined, 'the stack reads ANON_KEY: nothing else is written into a .env that has neither');
	assert.notEqual(rotatedKeys().JWT_SECRET, keys.JWT_SECRET);
});

test('a key is read under our name or the stack\'s, and rotated under each name the .env has', () => {
	assert.equal(envKey(new Map([['ANON_KEY', 'old']]), 'app'), 'old');
	assert.equal(envKey(new Map([['APP_KEY', 'new'], ['ANON_KEY', 'old']]), 'app'), 'new');
	assert.equal(envKey(new Map([['SERVICE_ROLE_KEY', 'old']]), 'server'), 'old');
	assert.equal(envKey(new Map([['SERVER_KEY', 'new']]), 'server'), 'new');
	assert.equal(envKey(new Map([['APP_KEY', '']]), 'app'), undefined);
	assert.equal(envKey(new Map(), 'server'), undefined);

	const both = rotatedKeys(new Map([['APP_KEY', 'a'], ['ANON_KEY', 'a'], ['SERVER_KEY', 's']]));
	assert.equal(both.APP_KEY, both.ANON_KEY);
	assert.equal(both.APP_KEY, apiKey(both.JWT_SECRET, 'anon'));
	assert.equal(both.SERVER_KEY, apiKey(both.JWT_SECRET, 'service_role'));
	assert.equal(both.SERVICE_ROLE_KEY, undefined, 'a name the file does not carry is not added');
});

test('a key is signed with the role names its database has', () => {
	const role = (key: string): string => JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role;
	// What snout-stack init writes from 0.1.6 on (the new layout), and 0.1.8 signs its keys for.
	const fresh = parseEnv('ANON_KEY=a\nSERVICE_ROLE_KEY=s\nREST_ANON_ROLE=snout_app\n');
	assert.deepEqual(keyRoles(fresh), { app: 'snout_app', server: 'snout_server' });
	const rotated = rotatedKeys(fresh);
	assert.equal(role(rotated.ANON_KEY), 'snout_app');
	assert.equal(role(rotated.SERVICE_ROLE_KEY), 'snout_server');
	assert.equal(rotated.SERVICE_ROLE_KEY, apiKey(rotated.JWT_SECRET, 'snout_server'));
	// A stack made before the new layout has no REST_ANON_ROLE, and no snout_app role to run as.
	const old = rotatedKeys(parseEnv('ANON_KEY=a\nSERVICE_ROLE_KEY=s\n'));
	assert.equal(role(old.ANON_KEY), 'anon');
	assert.equal(role(old.SERVICE_ROLE_KEY), 'service_role');
	assert.deepEqual(keyRoles(parseEnv('REST_ANON_ROLE=anon\n')), { app: 'anon', server: 'service_role' });
});

test('the owner password reaches Postgres as a SCRAM verifier, never as text', () => {
	// Computed independently (Python's hashlib), RFC 5802's definitions.
	const salt = Buffer.from([...Array(16).keys()]);
	assert.equal(scramVerifier('pencil', salt), 'SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$zHCdol2044/ZyWzPLi7oxApCkamKw9Z+E4U/QApd/5Y=:dd5peBOitVnLNFu7VmwP+HiDaaw4OUCv396eVCWhYiE=');
	const sql = ownerPasswordSql('abcdefghjkmnp', scramVerifier('secret-value'));
	assert.match(sql, /^alter role "abcdefghjkmnp_owner" with password 'SCRAM-SHA-256\$4096:/);
	assert.ok(!sql.includes('secret-value'));
	assert.throws(() => ownerPasswordSql('x"; drop', scramVerifier('p')));
	assert.throws(() => ownerPasswordSql('abcdefghjkmnp', "plain'; drop role x; --"));
});

test('exports are named by ref and moment, and a restore goes beside the database before it replaces it', () => {
	const name = exportName('abcdefghjkmnp', new Date('2026-10-01T09:08:07.123Z'));
	assert.equal(name, 'abcdefghjkmnp-20261001-090807.dump');
	assert.ok(isExportName(name));
	assert.ok(!isExportName('../.env'));
	assert.ok(!isExportName('abcdefghjkmnp-20261001-090807.dump.bak'));

	const script = restoreScript('abcdefghjkmnp');
	// Step one never touches the project's own database: it makes and fills the scratch one.
	assert.ok(!/drop database[^\n]*"abcdefghjkmnp"/.test(script));
	assert.match(script, /create database "abcdefghjkmnp_restore" template template0 owner "abcdefghjkmnp_owner"/);
	assert.match(script, /grep -v -E '[^']*\| EVENT TRIGGER '/, 'event triggers and pg_cron are left out of the main pass');
	assert.match(script, /EXTENSION - pg_cron/);
	assert.match(script, /alter function %s owner to snoutpod_admin/);
	assert.match(script, /\\i \/tmp\/snout-restore-et\.sql/);
	// An event trigger's owner is made again from the export's `ALTER EVENT TRIGGER … OWNER TO …`
	// lines, which hold names any role that can create roles chose (a quote, a dollar sign, a
	// newline). The shell never makes them into SQL: the lines reach the database as one properly
	// quoted psql literal, and parse_ident reads each name there, under a quoted heredoc.
	assert.ok(!/OWNERS=/.test(script), 'no SQL is assembled from the export in the shell');
	assert.ok(!/awk -v q=/.test(script));
	const ownersPass = script.slice(script.indexOf('snout-restore-et-owners.sql'));
	assert.match(ownersPass, /<<'SQL'\n\\set owners `cat \/tmp\/snout-restore-et-owners\.sql`\n/);
	assert.match(ownersPass, /\nset snout\.restore_owners = :'owners';\n/);
	assert.match(ownersPass, /parse_ident\(/);
	assert.ok(!/\$OWNERS|values \$/.test(script));

	const swap = restoreSwapSql('abcdefghjkmnp');
	const order = ['pg_drop_replication_slot', 'rename to "abcdefghjkmnp_replaced"', 'alter database "abcdefghjkmnp_restore" rename to "abcdefghjkmnp"', 'drop database "abcdefghjkmnp_replaced"'];
	assert.deepEqual(order.map((step) => swap.indexOf(step)), [...order.map((step) => swap.indexOf(step))].sort((a, b) => a - b));
	assert.ok(order.every((step) => swap.includes(step)));
	assert.throws(() => restoreSwapSql('postgres'));
});

test('functions/.env: names listed, one secret set or removed, every other line kept', () => {
	const text = '# mine\nA=1\nB="two words"\n';
	assert.deepEqual(secretNames(text), ['A', 'B']);
	assert.equal(withSecret(text, 'A', 'x y'), "# mine\nB=\"two words\"\nA='x y'\n");
	assert.equal(withSecret('', 'Q', `it's "q"`), `Q='it's "q"'\n`, 'one outer pair, which the stack takes off, whatever is inside');
	assert.ok(secretValueProblem('two\nlines'));
	assert.equal(withSecret(text, 'B', null), '# mine\nA=1\n');
	assert.equal(withSecret('', 'C', '3'), 'C=3\n');
	assert.equal(withSecret('C=3\n', 'C', null), '');
	assert.ok(secretNameProblem('SNOUTDATA_URL'));
	assert.ok(secretNameProblem('1X'));
	assert.equal(secretNameProblem('STRIPE_KEY'), null);
});

test('redirects and function limits round-trip through .env, and nonsense is refused', () => {
	const env = parseEnv('AUTH_URI_ALLOW_LIST=http://localhost:5173,https://a.example.com\nFUNCTIONS_CONTAINER_MEMORY=2g\nFUNCTIONS_NO_VERIFY_JWT=hook\n');
	const s = settingsFromEnv(env);
	assert.deepEqual(s.redirectUrls, ['http://localhost:5173', 'https://a.example.com']);
	assert.equal(s.functionsContainerMb, 2048);
	assert.equal(s.functionsMemoryMb, 256);
	assert.deepEqual(s.functionsNoVerify, ['hook']);
	const out = envForSettings({ redirectUrls: [' https://b.example.com ', ''], functionsContainerMb: 1536, functionsNoVerify: ['hook', 'bad name'] });
	assert.equal(out.AUTH_URI_ALLOW_LIST, 'https://b.example.com');
	assert.equal(out.FUNCTIONS_CONTAINER_MEMORY, '1536m');
	assert.equal(out.FUNCTIONS_NO_VERIFY_JWT, 'hook');
	assert.equal(memoryMb('512m', 0), 512);
	assert.equal(memoryMb('1073741824', 0), 1024);
	assert.equal(memoryMb('lots', 7), 7);
	assert.ok(settingsProblem({ redirectUrls: ['not a url'] }));
	assert.ok(settingsProblem({ functionsMemoryMb: 8 }));
	assert.ok(settingsProblem({ functionsMemoryMb: 512, functionsContainerMb: 256 }));
	assert.equal(settingsProblem({ redirectUrls: ['myapp://callback', 'https://x.example.com/a'] }), null);
});

test("auth's emails: the override hands auth the MAIL_* values, and a template must carry the link", () => {
	assert.match(APP_OVERRIDE, /AUTH_MAILER_TEMPLATES_CONFIRMATION: \$\{MAIL_TEMPLATE_CONFIRMATION:-\}/);
	assert.match(APP_OVERRIDE, /AUTH_MAILER_SUBJECTS_MAGIC_LINK: \$\{MAIL_SUBJECT_MAGIC_LINK:-\}/);
	assert.match(APP_OVERRIDE, /profiles: \[data-api\]/);
	assert.deepEqual(mailEnv('email_change'), { subject: 'MAIL_SUBJECT_EMAIL_CHANGE', template: 'MAIL_TEMPLATE_EMAIL_CHANGE' });
	assert.ok(overrideStale('# Written by the SnoutData desktop app: old\nservices: {}\n'));
	assert.ok(!overrideStale(APP_OVERRIDE));
	assert.ok(!overrideStale('services: {}\n'), "the user's own is never stale, it is theirs");
	assert.ok(mailTemplateProblem('Hi', '<p>no link</p>'));
	assert.ok(mailTemplateProblem('Hi', '<a href="{{ .ConfirmationURL }}">x</a> {{'));
	assert.ok(mailTemplateProblem('two\nlines', '{{ .Token }}'));
	assert.equal(mailTemplateProblem('Hi', '<a href="{{ .ConfirmationURL }}">x</a>'), null);
});
