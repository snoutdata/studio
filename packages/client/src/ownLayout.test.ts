/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The new names: every 0.3.x name is the SAME function as its new
// one, the client speaks the new paths, header, routes, fields and wire by default, and
// `vocabulary: 'old'` speaks the old ones. The other test files run in the old vocabulary, so they
// are the proof that 0.3.x code keeps working; this one is the proof of the new.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	AuthClient,
	BucketClient,
	createClient,
	FunctionsClient,
	procedure,
	QueryBuilder,
	RealtimeChannel,
	RealtimeClient,
	rpc,
	snout,
	SpaceClient,
	StorageClient,
	TableBuilder,
	type ChangesPayload,
	type SignalMessage,
	type SubscribeStatus,
	type Vocabulary
} from './index.js';
import { fakeFetch, fakeSocket, jwt, tick, type FakeSocket, type Frame, type Sent } from './testing.js';

const URL_ = 'https://abc123.api.snoutdata.com';

function tokenBody(access: string, refresh: string) {
	return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 3600, user: { id: 'u1', aud: 'authenticated', user_metadata: { name: 'Ana' }, app_metadata: { plan: 'pro' } } };
}

function client(vocabulary?: Vocabulary, answer?: (request: Sent) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
	const { fetch, sent } = fakeFetch(answer ?? (() => ({ body: [] })));
	const db = snout(URL_, 'app-key', {
		...(vocabulary ? { vocabulary } : {}),
		global: { fetch },
		auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
	});
	return { db, sent };
}

function path(request: Sent): string {
	const url = new URL(request.url);
	return `${url.pathname}${url.search}`;
}

test('every 0.3.x name is the same function (or object) as its new one', () => {
	const { db } = client();
	assert.equal(createClient, snout);
	assert.equal(rpc, procedure);
	assert.equal(BucketClient, SpaceClient);
	assert.equal(db.auth, db.identity);
	assert.equal(db.storage, db.files);
	assert.equal(db.functions, db.fn);
	assert.equal(db.realtime, db.live);
	assert.equal(db.identity.admin, db.identity.operator);
	assert.equal(db.restUrl, db.dataUrl);
	assert.equal(db.authUrl, db.identityUrl);
	assert.equal(db.storageUrl, db.filesUrl);
	assert.equal(db.functionsUrl, db.fnUrl);
	assert.equal(db.realtimeUrl, db.liveUrl);

	const pairs: [object, string, string][] = [
		[Object.getPrototypeOf(db), 'from', 'table'],
		[Object.getPrototypeOf(db), 'rpc', 'procedure'],
		[TableBuilder.prototype, 'select', 'read'],
		[TableBuilder.prototype, 'insert', 'add'],
		[TableBuilder.prototype, 'update', 'change'],
		[TableBuilder.prototype, 'upsert', 'put'],
		[TableBuilder.prototype, 'delete', 'remove'],
		[QueryBuilder.prototype, 'select', 'read'],
		[AuthClient.prototype, 'signUp', 'register'],
		[AuthClient.prototype, 'signInWithPassword', 'passwordSignIn'],
		[AuthClient.prototype, 'signInWithOtp', 'codeSignIn'],
		[AuthClient.prototype, 'signInWithOAuth', 'providerSignIn'],
		[AuthClient.prototype, 'signInWithSSO', 'ssoSignIn'],
		[AuthClient.prototype, 'signInAnonymously', 'guestSignIn'],
		[AuthClient.prototype, 'verifyOtp', 'confirmCode'],
		[AuthClient.prototype, 'exchangeCodeForSession', 'finishProviderSignIn'],
		[AuthClient.prototype, 'signOut', 'signOff'],
		[AuthClient.prototype, 'getSession', 'currentSession'],
		[AuthClient.prototype, 'getUser', 'currentPerson'],
		[AuthClient.prototype, 'refreshSession', 'renew'],
		[AuthClient.prototype, 'onAuthStateChange', 'onSessionChange'],
		[AuthClient.prototype, 'resetPasswordForEmail', 'sendReset'],
		[AuthClient.prototype, 'updateUser', 'changePerson'],
		[StorageClient.prototype, 'from', 'space'],
		[StorageClient.prototype, 'listBuckets', 'listSpaces'],
		[StorageClient.prototype, 'getBucket', 'getSpace'],
		[StorageClient.prototype, 'createBucket', 'createSpace'],
		[StorageClient.prototype, 'updateBucket', 'updateSpace'],
		[StorageClient.prototype, 'emptyBucket', 'emptySpace'],
		[StorageClient.prototype, 'deleteBucket', 'deleteSpace'],
		[SpaceClient.prototype, 'upload', 'put'],
		[SpaceClient.prototype, 'download', 'get'],
		[SpaceClient.prototype, 'createSignedUrl', 'signedLink'],
		[SpaceClient.prototype, 'getPublicUrl', 'publicLink'],
		[FunctionsClient.prototype, 'invoke', 'call'],
		[RealtimeClient.prototype, 'channel', 'topic'],
		[RealtimeChannel.prototype, 'on', 'listen'],
		[RealtimeChannel.prototype, 'subscribe', 'join'],
		[RealtimeChannel.prototype, 'send', 'signal'],
		[RealtimeChannel.prototype, 'track', 'announce']
	];
	for (const [proto, old, renamed] of pairs) {
		const record = proto as Record<string, unknown>;
		assert.equal(typeof record[renamed], 'function', `${renamed} is a method`);
		assert.equal(record[old], record[renamed], `${old} is ${renamed}`);
	}
});

test('the client-level channel() opens the same topic live.topic() does', () => {
	const { db } = client();
	const viaOld = db.channel('room:1');
	const viaNew = db.live.topic('room:1');
	assert.ok(viaOld instanceof RealtimeChannel);
	assert.equal(viaOld.topic, viaNew.topic);
	assert.deepEqual(db.getChannels(), [viaOld, viaNew]);
});

test('by default the data API is /v1/data and the key goes in Snout-Key, never apikey', async () => {
	const { db, sent } = client();
	assert.equal(db.vocabulary, 'new');
	assert.equal(db.dataUrl, `${URL_}/v1/data`);
	assert.equal(db.identityUrl, `${URL_}/v1/identity`);
	assert.equal(db.filesUrl, `${URL_}/v1/files`);
	assert.equal(db.fnUrl, `${URL_}/v1/fn`);
	assert.equal(db.liveUrl, 'wss://abc123.api.snoutdata.com/v1/live');
	assert.equal(db.pushUrl, `${URL_}/push/v1`);
	await db.table('todos').read('id').eq('done', false);
	await db.table('todos').add({ note: 'x' }).read();
	await db.procedure('add', { a: 1 });
	assert.deepEqual(sent.map(path), ['/v1/data/todos?select=id&done=eq.false', '/v1/data/todos?select=*', '/v1/data/rpc/add']);
	for (const request of sent) {
		assert.equal(request.headers['snout-key'], 'app-key');
		assert.equal(request.headers.apikey, undefined);
		assert.equal(request.headers.authorization, 'Bearer app-key');
	}
});

test('vocabulary: old speaks /rest/v1 and apikey, with the same calls', async () => {
	const { db, sent } = client('old');
	assert.equal(db.dataUrl, `${URL_}/rest/v1`);
	assert.equal(db.liveUrl, 'wss://abc123.api.snoutdata.com/realtime/v1');
	await db.table('todos').read('id');
	await db.from('todos').select('id');
	assert.deepEqual(sent.map(path), ['/rest/v1/todos?select=id', '/rest/v1/todos?select=id']);
	assert.equal(sent[0].headers.apikey, 'app-key');
	assert.equal(sent[0].headers['snout-key'], undefined);
});

test('identity speaks the new routes, via= and profile_data; old speaks the old ones', async () => {
	const access = jwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
	const answer = (request: Sent) => (/\/(session|token)\b/.test(request.url) ? { body: tokenBody(access, 'r1') } : { body: { id: 'u1' } });
	const expected: Record<Vocabulary, string[]> = {
		new: [
			'POST /v1/identity/register',
			'POST /v1/identity/session?via=password',
			'GET /v1/identity/person',
			'PUT /v1/identity/person',
			'POST /v1/identity/session?via=renew',
			'POST /v1/identity/code',
			'POST /v1/identity/confirm',
			'POST /v1/identity/reset',
			'POST /v1/identity/sign-off?scope=global'
		],
		old: [
			'POST /auth/v1/signup',
			'POST /auth/v1/token?grant_type=password',
			'GET /auth/v1/user',
			'PUT /auth/v1/user',
			'POST /auth/v1/token?grant_type=refresh_token',
			'POST /auth/v1/otp',
			'POST /auth/v1/verify',
			'POST /auth/v1/recover',
			'POST /auth/v1/logout?scope=global'
		]
	};
	for (const vocabulary of ['new', 'old'] as const) {
		const { db, sent } = client(vocabulary, answer);
		await db.identity.register({ email: 'a@example.com', password: 'pw', options: { profile_data: { name: 'Ana' } } });
		await db.identity.passwordSignIn({ email: 'a@example.com', password: 'pw' });
		await db.identity.currentPerson();
		await db.identity.changePerson({ profile_data: { name: 'Bea' } });
		await db.identity.renew();
		await db.identity.codeSignIn({ email: 'a@example.com', options: { profile_data: { name: 'Ana' } } });
		await db.identity.confirmCode({ email: 'a@example.com', token: '123456', type: 'email' });
		await db.identity.sendReset('a@example.com');
		await db.identity.signOff();
		assert.deepEqual(sent.map((s) => `${s.method} ${path(s)}`.replace(/\?redirect_to=?$/, '')), expected[vocabulary], vocabulary);
		const profileField = vocabulary === 'new' ? 'profile_data' : 'data';
		for (const at of [0, 3, 5]) {
			const body = JSON.parse(sent[at].body ?? '{}') as Record<string, unknown>;
			assert.ok(profileField in body, `${vocabulary} ${sent[at].url} sends ${profileField}`);
			assert.ok(!((vocabulary === 'new' ? 'data' : 'profile_data') in body));
		}
		assert.equal(sent[1].headers[vocabulary === 'new' ? 'snout-key' : 'apikey'], 'app-key');
	}
});

test('the 0.3.x option names are still read, and sent under the vocabulary\'s own name', async () => {
	const { db, sent } = client('new', () => ({ body: { id: 'u1' } }));
	await db.auth.signUp({ email: 'a@example.com', password: 'pw', options: { data: { name: 'Ana' } } });
	assert.deepEqual(JSON.parse(sent[0].body ?? '{}').profile_data, { name: 'Ana' });
	await db.auth.admin.createUser({ email: 'b@example.com', user_metadata: { a: 1 }, app_metadata: { b: 2 } });
	const created = JSON.parse(sent[1].body ?? '{}') as Record<string, unknown>;
	assert.equal(path(sent[1]), '/v1/identity/operator/people');
	assert.deepEqual([created.profile_data, created.server_data, created.user_metadata, created.app_metadata], [{ a: 1 }, { b: 2 }, undefined, undefined]);

	const old = client('old', () => ({ body: { id: 'u1' } }));
	await old.db.identity.operator.createUser({ email: 'b@example.com', profile_data: { a: 1 }, server_data: { b: 2 } });
	const oldBody = JSON.parse(old.sent[0].body ?? '{}') as Record<string, unknown>;
	assert.equal(path(old.sent[0]), '/auth/v1/admin/users');
	assert.deepEqual([oldBody.user_metadata, oldBody.app_metadata, oldBody.profile_data], [{ a: 1 }, { b: 2 }, undefined]);
});

test('a session and a person carry both names, whichever the server sent', async () => {
	const access = jwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
	// An old server: `user` and `user_metadata` only.
	const { db } = client('old', () => ({ body: tokenBody(access, 'r1') }));
	const { data } = await db.identity.passwordSignIn({ email: 'a@example.com', password: 'pw' });
	assert.equal(data.person, data.user);
	assert.equal(data.session?.person, data.session?.user);
	assert.deepEqual(data.person?.profile_data, { name: 'Ana' });
	assert.deepEqual(data.person?.user_metadata, { name: 'Ana' });
	assert.deepEqual(data.person?.server_data, { plan: 'pro' });
	// A new server: `person` and `profile_data` beside the old.
	const fresh = client('new', () => ({ body: { id: 'u2', profile_data: { name: 'Bea' }, server_data: {} } }));
	const person = (await fresh.db.identity.currentPerson(access)).data.person;
	assert.deepEqual(person?.user_metadata, { name: 'Bea' });
	assert.deepEqual(person?.profile_data, { name: 'Bea' });
});

test('provider and SSO sign-ins start at the new routes and finish at session?via=pkce', async () => {
	const access = jwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
	const { db, sent } = client('new', (request) =>
		request.url.includes('/sso/start') ? { body: { url: 'https://idp.example.com/login' } } : { body: tokenBody(access, 'r1') }
	);
	const { data } = await db.identity.providerSignIn({ provider: 'github', options: { skipBrowserRedirect: true } });
	assert.equal(new URL(data.url ?? '').pathname, '/v1/identity/provider/start');
	await db.identity.ssoSignIn({ domain: 'example.com', options: { skipBrowserRedirect: true } });
	assert.equal(path(sent[0]), '/v1/identity/sso/start');
	const finished = await db.identity.finishProviderSignIn('code-1');
	assert.equal(finished.error, null);
	assert.equal(path(sent[1]), '/v1/identity/session?via=pkce');
});

test('files speak /v1/files with space, file, image and signed; old speaks bucket and object', async () => {
	const answer = (request: Sent) =>
		request.url.includes('/sign') ? { body: { signedURL: '/object/sign/papers/a.pdf?token=t' } } : { body: { Id: 'i', Key: 'papers/a.pdf' } };
	const expected: Record<Vocabulary, string[]> = {
		new: [
			'GET /v1/files/space',
			'POST /v1/files/file/papers/a.pdf',
			'GET /v1/files/file/papers/a.pdf',
			'GET /v1/files/image/member/papers/a.pdf?width=64',
			'POST /v1/files/file/signed/papers/a.pdf',
			'POST /v1/files/file/list/papers',
			'DELETE /v1/files/file/papers'
		],
		old: [
			'GET /storage/v1/bucket',
			'POST /storage/v1/object/papers/a.pdf',
			'GET /storage/v1/object/papers/a.pdf',
			'GET /storage/v1/render/image/authenticated/papers/a.pdf?width=64',
			'POST /storage/v1/object/sign/papers/a.pdf',
			'POST /storage/v1/object/list/papers',
			'DELETE /storage/v1/object/papers'
		]
	};
	for (const vocabulary of ['new', 'old'] as const) {
		const { db, sent } = client(vocabulary, answer);
		const space = db.files.space('papers');
		await db.files.listSpaces();
		await space.put('a.pdf', 'x');
		await space.get('a.pdf');
		await space.get('a.pdf', { transform: { width: 64 } });
		const signed = await space.signedLink('a.pdf', 60);
		await space.list();
		await space.remove(['a.pdf']);
		assert.deepEqual(sent.map((s) => `${s.method} ${path(s)}`), expected[vocabulary], vocabulary);
		const prefix = vocabulary === 'new' ? '/v1/files' : '/storage/v1';
		assert.equal(signed.data?.signedUrl, `${URL_}${prefix}/object/sign/papers/a.pdf?token=t`);
		const publicRoute = vocabulary === 'new' ? 'file/public' : 'object/public';
		const imageRoute = vocabulary === 'new' ? 'image/public' : 'render/image/public';
		assert.equal(space.publicLink('a.pdf').data.publicUrl, `${URL_}${prefix}/${publicRoute}/papers/a.pdf`);
		assert.equal(space.publicLink('a.pdf', { transform: { width: 8 } }).data.publicUrl, `${URL_}${prefix}/${imageRoute}/papers/a.pdf?width=8`);
	}
});

test('fn.call reaches /v1/fn with Snout-Key; old reaches /functions/v1 with apikey', async () => {
	for (const vocabulary of ['new', 'old'] as const) {
		const { db, sent } = client(vocabulary, () => ({ body: { ok: true } }));
		const { data } = await db.fn.call('echo', { body: { a: 1 } });
		assert.deepEqual(data, { ok: true });
		assert.equal(path(sent[0]), vocabulary === 'new' ? '/v1/fn/echo' : '/functions/v1/echo');
		assert.equal(sent[0].headers[vocabulary === 'new' ? 'snout-key' : 'apikey'], 'app-key');
	}
});

test('a redirect to another origin drops Snout-Key as it dropped apikey', async () => {
	const { db, sent } = client('new', (request) =>
		request.url.startsWith(URL_) ? { status: 307, body: '', headers: { location: 'https://elsewhere.example.com/x' } } : { body: { ok: true } }
	);
	await db.fn.call('x');
	assert.equal(sent[0].headers['snout-key'], 'app-key');
	assert.equal(sent[1].headers['snout-key'], undefined);
	assert.equal(sent[1].headers.authorization, undefined);
});

/** A live server that speaks only the new wire, as snout-realtime does to a client that joined `live:`. */
function liveServer() {
	return fakeSocket((frame: Frame, socket: FakeSocket) => {
		if (frame.event === 'phx_join') {
			const config = (frame.payload.config ?? {}) as { changes?: Record<string, unknown>[] };
			const changes = config.changes ?? [];
			socket.reply(frame, { changes: changes.map((f, i) => ({ ...f, id: 100 + i })) });
			if (changes.length > 0) {
				queueMicrotask(() =>
					socket.serve({ topic: frame.topic, event: 'system', payload: { status: 'ok', extension: 'changes', message: 'Subscribed to PostgreSQL' }, ref: null })
				);
			}
		} else if (frame.event === 'signal') {
			socket.serve({ topic: frame.topic, event: 'signal', payload: frame.payload, ref: null });
		} else if (frame.event === 'phx_leave' || frame.event === 'heartbeat' || frame.event === 'roster') {
			socket.reply(frame);
		}
	});
}

function joined(topic: RealtimeChannel): Promise<SubscribeStatus> {
	return new Promise((resolve) => {
		topic.join((status) => resolve(status));
	});
}

test('live speaks /v1/live, live: topics and the new events and config keys', async () => {
	const { transport, sockets } = liveServer();
	const { fetch } = fakeFetch();
	const db = snout(URL_, 'app-key', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport, timeoutMs: 200 } });
	const changes: ChangesPayload[] = [];
	const signals: SignalMessage[] = [];
	let synced = 0;
	const topic = db.live
		.topic('room:7', { config: { signal: { self: true }, roster: { key: 'ana' } } })
		.listen('changes', { event: 'INSERT', schema: 'public', table: 'todos' }, (p) => changes.push(p))
		.listen('signal', { event: 'ping' }, (m) => signals.push(m))
		.listen('roster', { event: 'sync' }, () => synced++);
	assert.equal(topic.topic, 'live:room:7');
	assert.equal(await joined(topic), 'SUBSCRIBED');

	const url = new URL(sockets[0].url);
	assert.equal(url.origin + url.pathname, 'wss://abc123.api.snoutdata.com/v1/live/websocket');
	const join = sockets[0].frames.find((f) => f.event === 'phx_join');
	assert.equal(join?.topic, 'live:room:7');
	assert.deepEqual(Object.keys(join?.payload.config as object).sort(), ['changes', 'private', 'roster', 'signal']);
	assert.deepEqual((join?.payload.config as { roster: unknown }).roster, { key: 'ana', enabled: true });
	assert.deepEqual((join?.payload.config as { signal: unknown }).signal, { self: true, ack: false });

	sockets[0].serve({
		topic: 'live:room:7',
		event: 'changes',
		payload: { ids: [100], data: { schema: 'public', table: 'todos', commit_timestamp: 't', type: 'INSERT', record: { id: 1 }, errors: null } },
		ref: null
	});
	assert.deepEqual(changes[0]?.new, { id: 1 });

	assert.equal(await topic.signal({ type: 'signal', event: 'ping', payload: { n: 1 } }), 'ok');
	await tick();
	const sentSignal = sockets[0].frames.find((f) => f.event === 'signal');
	assert.equal(sentSignal?.payload.type, 'signal');
	assert.deepEqual(signals[0], { type: 'signal', event: 'ping', payload: { n: 1 } });

	assert.equal(await topic.announce({ online: true }), 'ok');
	const announced = sockets[0].frames.find((f) => f.event === 'roster');
	assert.deepEqual(announced?.payload, { type: 'roster', event: 'track', payload: { online: true } });
	sockets[0].serve({ topic: 'live:room:7', event: 'roster_state', payload: { ana: { metas: [{ phx_ref: 'p1', online: true }] } }, ref: null });
	assert.equal(synced, 1);
	assert.deepEqual(Object.keys(topic.presenceState()), ['ana']);
	await db.removeAllChannels();
});

test('a signal on a topic that is not joined goes to /v1/live/signal', async () => {
	const { transport } = liveServer();
	const { fetch, sent } = fakeFetch(() => ({ status: 202 }));
	const db = snout(URL_, 'app-key', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport } });
	assert.equal(await db.live.topic('room:9').signal({ type: 'signal', event: 'hi', payload: { a: 1 } }), 'ok');
	assert.equal(sent[0].url, `${URL_}/v1/live/signal`);
	assert.equal(sent[0].headers['snout-key'], 'app-key');
	assert.deepEqual(JSON.parse(sent[0].body ?? ''), { messages: [{ topic: 'room:9', event: 'hi', payload: { a: 1 }, private: false }] });
});

test('0.3.x live code (channel, on, subscribe, send) runs unchanged over the new wire', async () => {
	const { transport, sockets } = liveServer();
	const { fetch } = fakeFetch();
	const db = createClient(URL_, 'app-key', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport, timeoutMs: 200 } });
	const heard: unknown[] = [];
	const channel = db.channel('room:1', { config: { broadcast: { self: true } } }).on('broadcast', { event: 'ping' }, (m) => heard.push(m.payload));
	const status = await new Promise<SubscribeStatus>((resolve) => channel.subscribe((s) => resolve(s)));
	assert.equal(status, 'SUBSCRIBED');
	assert.equal(await channel.send({ type: 'broadcast', event: 'ping', payload: { n: 2 } }), 'ok');
	await tick();
	assert.deepEqual(heard, [{ n: 2 }]);
	const join = sockets[0].frames.find((f) => f.event === 'phx_join');
	assert.deepEqual((join?.payload.config as { signal: unknown }).signal, { self: true, ack: false });
	await db.removeChannel(channel);
});
