/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live: one websocket at `/v1/live` (`/realtime/v1` in the old vocabulary), carrying signals,
 * the roster (who is present) and table changes.
 *
 * The wire is Phoenix channels (protocol 1.0.0): every frame is JSON
 * `{ topic, event, payload, ref, join_ref }`. A topic named `room:42` is `live:room:42` on the
 * wire; it is joined with a `phx_join` whose payload says what it wants (signal options, a
 * roster key, which table changes), answered by a `phx_reply` carrying the same `ref`. The
 * socket is kept alive by a `heartbeat` on the `phoenix` topic every 25 seconds, and when it
 * drops it is reopened and every topic that was joined is joined again, so a listener survives
 * a network blip without writing any code for it.
 *
 * In the old vocabulary the same frames say `realtime:`, `broadcast`, `presence` and
 * `postgres_changes`. Everything inside this file speaks the old names; a frame is put into the
 * new ones as it leaves and back as it arrives (`speak`, `hear`), as the server does.
 *
 * The socket opens on the first `join()`, not before: a page that never joins never holds a
 * connection.
 */

import { joinUrl, type Transport, type Vocabulary } from './http.js';

/** The wire's event names, old then new. The first three are also a join's config keys. */
const WIRE_NAMES: readonly (readonly [old: string, renamed: string])[] = [
	['postgres_changes', 'changes'],
	['broadcast', 'signal'],
	['presence', 'roster'],
	['presence_state', 'roster_state'],
	['presence_diff', 'roster_diff']
];

/** A topic's prefix on the wire, per vocabulary. */
const TOPIC_PREFIX: Record<Vocabulary, string> = { old: 'realtime:', new: 'live:' };

function newName(name: string): string {
	return WIRE_NAMES.find(([old]) => old === name)?.[1] ?? name;
}

function oldName(name: string): string {
	return WIRE_NAMES.find(([, renamed]) => renamed === name)?.[0] ?? name;
}

function renameKeys(record: Record<string, unknown>, rename: (key: string) => string): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).map(([key, value]) => [rename(key), value]));
}

export type ChannelState = 'closed' | 'joining' | 'joined' | 'leaving' | 'errored';

export type SubscribeStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export type SendStatus = 'ok' | 'error' | 'timed out';

export interface SignalOptions {
	/** Hear your own signals. */
	self?: boolean;
	/** `signal()` waits for the server to confirm. */
	ack?: boolean;
	replay?: { since: number; limit?: number };
}

export interface RosterOptions {
	/** The key this client is announced under. A random one when omitted. */
	key?: string;
	enabled?: boolean;
}

export interface ChannelOptions {
	config?: {
		signal?: SignalOptions;
		roster?: RosterOptions;
		/** @deprecated Since 0.4.0: `signal`. */
		broadcast?: SignalOptions;
		/** @deprecated Since 0.4.0: `roster`. */
		presence?: RosterOptions;
		/** Authorised by RLS on the project's live signals table rather than open to anyone with the key. */
		private?: boolean;
	};
}

/** What `live.topic()` takes. */
export type TopicOptions = ChannelOptions;

export interface ChangesFilter {
	event: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
	schema: string;
	table?: string;
	/** One condition in PostgREST syntax, `id=eq.7`. */
	filter?: string;
}

/** @deprecated Since 0.4.0: `ChangesFilter`. */
export type PostgresChangesFilter = ChangesFilter;

export interface ChangesPayload<T = Record<string, unknown>> {
	schema: string;
	table: string;
	commit_timestamp: string;
	eventType: 'INSERT' | 'UPDATE' | 'DELETE';
	/** The row after the change; `{}` for a delete. */
	new: Partial<T>;
	/** The row before it: the primary key only, unless the table is REPLICA IDENTITY FULL. */
	old: Partial<T>;
	errors: string[] | null;
}

/** @deprecated Since 0.4.0: `ChangesPayload`. */
export type PostgresChangesPayload<T = Record<string, unknown>> = ChangesPayload<T>;

/** A signal as it arrives. `type` is the vocabulary's own name for it. */
export interface SignalMessage<T = Record<string, unknown>> {
	type: 'signal' | 'broadcast';
	event: string;
	payload: T;
}

/** @deprecated Since 0.4.0: `SignalMessage`. */
export type BroadcastMessage<T = Record<string, unknown>> = SignalMessage<T>;

export type Presence<T = Record<string, unknown>> = T & { presence_ref: string };

export interface RosterJoin<T = Record<string, unknown>> {
	event: 'join';
	key: string;
	currentPresences: Presence<T>[];
	newPresences: Presence<T>[];
}

/** @deprecated Since 0.4.0: `RosterJoin`. */
export type PresenceJoin<T = Record<string, unknown>> = RosterJoin<T>;

export interface RosterLeave<T = Record<string, unknown>> {
	event: 'leave';
	key: string;
	currentPresences: Presence<T>[];
	leftPresences: Presence<T>[];
}

/** @deprecated Since 0.4.0: `RosterLeave`. */
export type PresenceLeave<T = Record<string, unknown>> = RosterLeave<T>;

interface Frame {
	topic: string;
	event: string;
	payload: Record<string, unknown>;
	ref: string | null;
	join_ref?: string | null;
}

interface Binding {
	type: string;
	filter: Record<string, unknown>;
	callback: (payload: never) => void;
	/** The id the server gave a table-changes subscription in its join reply. */
	id?: number;
}

type Reply = { status: string; response: Record<string, unknown> };

/**
 * A realtime handler (`realtime.on()`) that did not complete. `code` is `unauthorized`,
 * `timeout`, `no_handler`, `not_joined`, `timed_out` (no reply came), or the SQLSTATE the
 * handler raised (`P0001` for a plain `raise exception`).
 */
export class RealtimeHandlerError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = 'RealtimeHandlerError';
		this.code = code;
	}
}

export interface RealtimeOptions {
	/** A WebSocket constructor, where the platform has none. Node 22 and every browser do. */
	transport?: typeof WebSocket;
	heartbeatIntervalMs?: number;
	/** How long a join, leave or acknowledged send may wait for its reply. */
	timeoutMs?: number;
	params?: Record<string, string>;
}

const PROTOCOL = '1.0.0';
const BACKOFF = [1000, 2000, 5000, 10000];

function backoff(tries: number): number {
	return BACKOFF[Math.min(tries, BACKOFF.length - 1)];
}

function unref(timer: ReturnType<typeof setTimeout>): void {
	(timer as { unref?: () => void }).unref?.();
}

export class RealtimeClient {
	/** The `wss://` URL, for inspection. */
	readonly url: string;
	private readonly key: string;
	private readonly options: RealtimeOptions;
	private readonly transport: Transport;
	private readonly httpUrl: string;
	private readonly tokenSource: () => Promise<string>;
	private socket: WebSocket | null = null;
	private readonly channels = new Set<RealtimeChannel>();
	private readonly pending = new Map<string, { resolve: (reply: Reply) => void; timer: ReturnType<typeof setTimeout> }>();
	private buffer: string[] = [];
	private ref = 0;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private heartbeatRef: string | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectTries = 0;
	private closedByUs = false;
	/** @internal */ accessToken: string | null = null;

	/** @internal Which names the wire speaks. */
	readonly vocabulary: Vocabulary;

	/** @deprecated Since 0.4.0: use `topic()`, the same function. Removed in 0.5.0. */
	declare channel: RealtimeClient['topic'];

	constructor(url: string, key: string, transport: Transport, tokenSource: () => Promise<string>, options: RealtimeOptions = {}, vocabulary: Vocabulary = 'new') {
		this.url = url;
		this.httpUrl = url.replace(/^ws/, 'http');
		this.key = key;
		this.transport = transport;
		this.tokenSource = tokenSource;
		this.options = options;
		this.vocabulary = vocabulary;
	}

	/** @internal */
	get timeoutMs(): number {
		return this.options.timeoutMs ?? 10_000;
	}

	/** @internal */
	nextRef(): string {
		this.ref += 1;
		return String(this.ref);
	}

	/** A topic to listen on and signal to. Nothing is sent until `join()`. */
	topic(name: string, options: TopicOptions = {}): RealtimeChannel {
		const channel = new RealtimeChannel(name, options, this);
		this.channels.add(channel);
		return channel;
	}

	getChannels(): RealtimeChannel[] {
		return [...this.channels];
	}

	async removeChannel(channel: RealtimeChannel): Promise<SendStatus> {
		const status = await channel.unsubscribe();
		this.channels.delete(channel);
		if (this.channels.size === 0) {
			this.disconnect();
		}
		return status;
	}

	async removeAllChannels(): Promise<SendStatus[]> {
		const statuses = await Promise.all([...this.channels].map((channel) => channel.unsubscribe()));
		this.channels.clear();
		this.disconnect();
		return statuses;
	}

	isConnected(): boolean {
		return this.socket?.readyState === 1;
	}

	/** Re-authorise every joined topic with a new access token, after a sign-in or refresh. */
	setAuth(token: string | null): void {
		const next = token ?? this.key;
		if (next === this.accessToken) {
			return;
		}
		this.accessToken = next;
		for (const channel of this.channels) {
			if (channel.state === 'joined') {
				this.push({ topic: channel.topic, event: 'access_token', payload: { access_token: next }, ref: this.nextRef(), join_ref: channel.joinRef });
			}
		}
	}

	/** @internal */
	async token(): Promise<string> {
		this.accessToken = await this.tokenSource();
		return this.accessToken;
	}

	/** @internal Opens the socket if it is not open or opening. */
	connect(): void {
		if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) {
			return;
		}
		const Socket = this.options.transport ?? globalThis.WebSocket;
		if (typeof Socket !== 'function') {
			throw new Error('This platform has no WebSocket. Pass one as `realtime.transport`.');
		}
		this.closedByUs = false;
		const params = new URLSearchParams({ ...this.options.params, apikey: this.key, vsn: PROTOCOL });
		const socket = new Socket(`${joinUrl(this.url, 'websocket')}?${params}`);
		this.socket = socket;
		socket.onopen = () => this.opened();
		socket.onmessage = (event: MessageEvent) => this.received(event.data);
		socket.onclose = () => this.closed(socket);
		socket.onerror = () => {
			// Every error is followed by a close, which is where it is handled.
		};
	}

	/** Closes the socket and keeps it closed. */
	disconnect(): void {
		this.closedByUs = true;
		clearTimeout(this.reconnectTimer);
		this.stopHeartbeat();
		const socket = this.socket;
		this.socket = null;
		if (socket && socket.readyState < 2) {
			socket.close(1000, 'client disconnect');
		}
		this.buffer = [];
	}

	/** @internal */
	push(frame: Frame): void {
		const text = JSON.stringify(this.speak(frame));
		if (this.socket?.readyState === 1) {
			this.socket.send(text);
		} else {
			this.buffer.push(text);
		}
	}

	/** @internal A frame that expects a `phx_reply` with its ref. */
	request(frame: Frame, timeoutMs = this.timeoutMs): Promise<Reply> {
		return new Promise((resolve) => {
			const ref = frame.ref ?? this.nextRef();
			const timer = setTimeout(() => {
				this.pending.delete(ref);
				resolve({ status: 'timeout', response: {} });
			}, timeoutMs);
			unref(timer);
			this.pending.set(ref, { resolve, timer });
			this.push({ ...frame, ref });
		});
	}

	/** @internal The wire topic for a name, in this client's vocabulary. */
	topicFor(name: string): string {
		return `${TOPIC_PREFIX[this.vocabulary]}${name}`;
	}

	/** A frame as it leaves: in the new vocabulary, its event, its payload's `type` and a join's config keys renamed. */
	private speak(frame: Frame): Frame {
		if (this.vocabulary === 'old' || !frame.topic.startsWith(TOPIC_PREFIX.new)) {
			return frame;
		}
		let payload = frame.payload;
		if (typeof payload.type === 'string') {
			payload = { ...payload, type: newName(payload.type) };
		}
		if (frame.event === 'phx_join' && payload.config !== null && typeof payload.config === 'object') {
			payload = { ...payload, config: renameKeys(payload.config as Record<string, unknown>, newName) };
		}
		return { ...frame, event: newName(frame.event), payload };
	}

	/**
	 * A frame as it arrives, in the old names this file works in: its event, a `system` message's
	 * extension and a reply's keys. A signal's own `type` is left as the server said it, since it
	 * is handed to the listener as it came.
	 */
	private hear(frame: Frame): Frame {
		if (this.vocabulary === 'old' || typeof frame.topic !== 'string' || !frame.topic.startsWith(TOPIC_PREFIX.new)) {
			return frame;
		}
		let payload = frame.payload ?? {};
		if (typeof payload.extension === 'string') {
			payload = { ...payload, extension: oldName(payload.extension) };
		}
		if (frame.event === 'phx_reply' && payload.response !== null && typeof payload.response === 'object') {
			payload = { ...payload, response: renameKeys(payload.response as Record<string, unknown>, oldName) };
		}
		return { ...frame, event: oldName(frame.event), payload };
	}

	/** @internal A signal over HTTP, for a topic that is not joined. */
	async broadcastOverHttp(topic: string, event: string, payload: unknown, isPrivate: boolean): Promise<SendStatus> {
		try {
			const headers = { ...(await this.transport.headers()), 'Content-Type': 'application/json' };
			const response = await this.transport.fetch(joinUrl(this.httpUrl, this.vocabulary === 'old' ? 'api/broadcast' : 'signal'), {
				method: 'POST',
				headers,
				body: JSON.stringify({ messages: [{ topic, event, payload, private: isPrivate }] })
			});
			await response.body?.cancel();
			return response.ok ? 'ok' : 'error';
		} catch {
			return 'error';
		}
	}

	private opened(): void {
		this.reconnectTries = 0;
		const queued = this.buffer;
		this.buffer = [];
		for (const text of queued) {
			this.socket?.send(text);
		}
		this.startHeartbeat();
		for (const channel of this.channels) {
			channel.socketOpened();
		}
	}

	private closed(socket: WebSocket): void {
		if (socket !== this.socket && this.socket !== null) {
			return;
		}
		this.stopHeartbeat();
		for (const [ref, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.resolve({ status: 'error', response: { reason: 'the socket closed' } });
			this.pending.delete(ref);
		}
		for (const channel of this.channels) {
			channel.socketClosed();
		}
		if (this.closedByUs || ![...this.channels].some((channel) => channel.wanted)) {
			return;
		}
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTries += 1;
			this.connect();
		}, backoff(this.reconnectTries));
		// Not unref'd: a Node process whose only job is to listen must survive the gap.
	}

	private received(data: unknown): void {
		if (typeof data !== 'string') {
			return;
		}
		let frame: Frame;
		try {
			frame = this.hear(JSON.parse(data) as Frame);
		} catch {
			return;
		}
		// `null`, a number or an array parses as JSON too, and a server can send one.
		if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
			return;
		}
		if (frame.topic === 'phoenix' && frame.ref === this.heartbeatRef) {
			this.heartbeatRef = null;
		}
		if (frame.event === 'phx_reply' && frame.ref !== null) {
			const entry = this.pending.get(frame.ref);
			if (entry) {
				clearTimeout(entry.timer);
				this.pending.delete(frame.ref);
				entry.resolve(frame.payload as unknown as Reply);
			}
		}
		for (const channel of this.channels) {
			if (channel.topic === frame.topic) {
				channel.receive(frame);
			}
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeat = setInterval(() => {
			if (this.heartbeatRef !== null) {
				// The last one was never answered: the connection is dead even if it looks open.
				this.heartbeatRef = null;
				this.socket?.close(4000, 'heartbeat timeout');
				return;
			}
			this.heartbeatRef = this.nextRef();
			this.push({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: this.heartbeatRef });
		}, this.options.heartbeatIntervalMs ?? 25_000);
		unref(this.heartbeat);
	}

	private stopHeartbeat(): void {
		clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		this.heartbeatRef = null;
	}
}

export class RealtimeChannel {
	/** The topic on the wire: `live:<name>` (`realtime:<name>` in the old vocabulary). */
	readonly topic: string;
	/** The name it was created with. */
	readonly name: string;
	state: ChannelState = 'closed';
	/** @internal */ joinRef: string | null = null;
	/** @internal Whether the caller wants this joined; a dropped socket rejoins only these. */
	wanted = false;
	private readonly options: ChannelOptions;
	private readonly client: RealtimeClient;
	private readonly bindings: Binding[] = [];
	private presence: Record<string, Presence[]> = {};
	/**
	 * What this client last announced with `track`, re-sent on every rejoin.
	 *
	 * Presence lives on the server as long as the channel process that tracked it. When the
	 * channel is closed (the server's "Too many messages per second", a dropped socket, a
	 * restart), the rejoin is automatic but the presence was not: everybody else saw this
	 * player leave and never come back, although the socket was fine. Remembering the state is
	 * what makes a rejoin restore the player as well as the channel.
	 */
	private tracked: Record<string, unknown> | null = null;
	private statusCallback: ((status: SubscribeStatus, error?: Error) => void) | undefined;
	private rejoinTimer: ReturnType<typeof setTimeout> | undefined;
	private rejoinTries = 0;
	/** Set while a joined channel waits for Realtime to say its table changes are live. */
	private awaitingChanges: ReturnType<typeof setTimeout> | undefined;
	/**
	 * What Realtime said about the table changes while the join still waited for its reply
	 * (null: they are live). In Node one socket read can carry the reply AND that message,
	 * and both are handled before the join sees its reply, so it is kept for the join.
	 */
	private earlyChanges: string | null | undefined;

	constructor(name: string, options: ChannelOptions, client: RealtimeClient) {
		this.name = name;
		this.topic = client.topicFor(name);
		this.options = options;
		this.client = client;
	}

	/** @deprecated Since 0.4.0: use `listen()`, the same function, with `changes`, `signal` or `roster`. Removed in 0.5.0. */
	declare on: {
		(type: 'broadcast', filter: { event: string }, callback: (message: SignalMessage) => void): RealtimeChannel;
		(type: 'presence', filter: { event: 'sync' }, callback: () => void): RealtimeChannel;
		(type: 'presence', filter: { event: 'join' }, callback: (join: RosterJoin) => void): RealtimeChannel;
		(type: 'presence', filter: { event: 'leave' }, callback: (leave: RosterLeave) => void): RealtimeChannel;
		<T extends Record<string, unknown> = Record<string, unknown>>(
			type: 'postgres_changes',
			filter: ChangesFilter,
			callback: (payload: ChangesPayload<T>) => void
		): RealtimeChannel;
		(type: 'system', filter: Record<string, never>, callback: (message: Record<string, unknown>) => void): RealtimeChannel;
	};
	/** @deprecated Since 0.4.0: use `join()`, the same function. Removed in 0.5.0. */
	declare subscribe: RealtimeChannel['join'];
	/** @deprecated Since 0.4.0: use `signal()`, the same function. Removed in 0.5.0. */
	declare send: RealtimeChannel['signal'];
	/** @deprecated Since 0.4.0: use `announce()`, the same function. Removed in 0.5.0. */
	declare track: RealtimeChannel['announce'];

	/** Hear `signal`s (by event name), the `roster` (`sync`, `join`, `leave`), table `changes`, or `system` messages. */
	listen(type: 'signal', filter: { event: string }, callback: (message: SignalMessage) => void): this;
	listen(type: 'roster', filter: { event: 'sync' }, callback: () => void): this;
	listen(type: 'roster', filter: { event: 'join' }, callback: (join: RosterJoin) => void): this;
	listen(type: 'roster', filter: { event: 'leave' }, callback: (leave: RosterLeave) => void): this;
	listen<T extends Record<string, unknown> = Record<string, unknown>>(
		type: 'changes',
		filter: ChangesFilter,
		callback: (payload: ChangesPayload<T>) => void
	): this;
	listen(type: 'system', filter: Record<string, never>, callback: (message: Record<string, unknown>) => void): this;
	listen(type: string, filter: object, callback: (payload: never) => void): this {
		// Kept by the old name, which is what this file works in; either name may be given.
		this.bindings.push({ type: oldName(type), filter: filter as Record<string, unknown>, callback });
		return this;
	}

	/**
	 * Joins. `callback` hears SUBSCRIBED, and afterwards CHANNEL_ERROR, TIMED_OUT or CLOSED;
	 * after an error the topic keeps trying to rejoin on its own.
	 */
	join(callback?: (status: SubscribeStatus, error?: Error) => void): this {
		if (this.wanted) {
			throw new Error(`topic ${this.name} is already joined; create a new topic to join again`);
		}
		this.wanted = true;
		this.statusCallback = callback;
		this.client.connect();
		if (this.client.isConnected()) {
			void this.attach();
		}
		return this;
	}

	/** Leaves. The topic can be discarded afterwards; `removeChannel` also forgets it. */
	async unsubscribe(): Promise<SendStatus> {
		this.wanted = false;
		this.tracked = null;
		clearTimeout(this.rejoinTimer);
		clearTimeout(this.awaitingChanges);
		this.awaitingChanges = undefined;
		if (this.state !== 'joined' && this.state !== 'joining') {
			this.state = 'closed';
			return 'ok';
		}
		this.state = 'leaving';
		const reply = await this.client.request({ topic: this.topic, event: 'phx_leave', payload: {}, ref: null, join_ref: this.joinRef });
		this.state = 'closed';
		this.statusCallback?.('CLOSED');
		return reply.status === 'ok' ? 'ok' : reply.status === 'timeout' ? 'timed out' : 'error';
	}

	/**
	 * Sends a signal, or a roster announce/untrack (`type` in either vocabulary). On a joined
	 * topic it goes over the socket; on one that is not joined, a signal goes over HTTP instead,
	 * so a server can signal without holding a socket open.
	 */
	async signal(message: { type: 'signal' | 'roster' | 'broadcast' | 'presence'; event: string; payload?: unknown; [field: string]: unknown }): Promise<SendStatus> {
		// Worked in the old names, like everything in this file; `speak` renames it on the way out.
		const type = oldName(message.type);
		if (this.state !== 'joined' || !this.client.isConnected()) {
			if (type !== 'broadcast') {
				return 'error';
			}
			return this.client.broadcastOverHttp(this.name, message.event, message.payload ?? {}, this.options.config?.private ?? false);
		}
		const frame: Frame = { topic: this.topic, event: type, payload: { ...message, type } as Record<string, unknown>, ref: null, join_ref: this.joinRef };
		const acknowledged = type === 'presence' || this.signalOptions().ack === true;
		if (!acknowledged) {
			this.client.push({ ...frame, ref: this.client.nextRef() });
			return 'ok';
		}
		const reply = await this.client.request(frame);
		return reply.status === 'ok' ? 'ok' : reply.status === 'timeout' ? 'timed out' : 'error';
	}

	/**
	 * Runs the project's realtime handler for `event` on this channel (registered with
	 * `realtime.on()` in SQL) as the signed-in user, and resolves with what it returned. What the
	 * handler sends with `realtime.emit()` reaches the channel only if it succeeded. The channel
	 * must be joined.
	 */
	async call<T = unknown>(event: string, payload: unknown = {}): Promise<{ data: T | null; error: RealtimeHandlerError | null }> {
		if (this.state !== 'joined' || !this.client.isConnected()) {
			return { data: null, error: new RealtimeHandlerError('The channel is not joined', 'not_joined') };
		}
		// `call: true` tells Realtime to answer `no_handler` rather than relay the message when no
		// handler is registered for it.
		const frame: Frame = {
			topic: this.topic,
			event: 'broadcast',
			payload: { type: 'broadcast', event, payload, call: true },
			ref: null,
			join_ref: this.joinRef
		};
		const reply = await this.client.request(frame);
		if (reply.status === 'ok') {
			return { data: (reply.response.result ?? null) as T | null, error: null };
		}
		if (reply.status === 'timeout') {
			return { data: null, error: new RealtimeHandlerError('Realtime did not answer in time', 'timed_out') };
		}
		const failure = reply.response.error as { code?: string; message?: string } | string | undefined;
		if (typeof failure === 'object' && failure !== null) {
			return { data: null, error: new RealtimeHandlerError(failure.message ?? 'The handler failed', failure.code ?? 'error') };
		}
		return { data: null, error: new RealtimeHandlerError(typeof failure === 'string' ? failure : 'The handler failed', typeof failure === 'string' ? failure : 'error') };
	}

	/** Announce this client on the topic's roster with `state`, replacing what it announced before. */
	announce(state: Record<string, unknown>): Promise<SendStatus> {
		// Kept even when the send fails (the topic is rejoining): the next join sends it.
		this.tracked = state;
		return this.signal({ type: 'presence', event: 'track', payload: state });
	}

	/** Leaves the roster, staying on the topic. */
	untrack(): Promise<SendStatus> {
		this.tracked = null;
		return this.signal({ type: 'presence', event: 'untrack' });
	}

	private signalOptions(): SignalOptions {
		return this.options.config?.signal ?? this.options.config?.broadcast ?? {};
	}

	private rosterOptions(): RosterOptions | undefined {
		return this.options.config?.roster ?? this.options.config?.presence;
	}

	/** After a join: announce again whatever was tracked before the channel was lost. */
	private retrack(): void {
		if (this.tracked) {
			void this.signal({ type: 'presence', event: 'track', payload: this.tracked });
		}
	}

	/** Everyone present, by key. Each key may be present more than once (two tabs). */
	presenceState<T extends Record<string, unknown> = Record<string, unknown>>(): Record<string, Presence<T>[]> {
		return structuredClone(this.presence) as Record<string, Presence<T>[]>;
	}

	// ---- driven by the client ----

	/** @internal */
	socketOpened(): void {
		if (this.wanted && this.state !== 'joined' && this.state !== 'joining') {
			void this.attach();
		}
	}

	/** @internal */
	socketClosed(): void {
		clearTimeout(this.rejoinTimer);
		clearTimeout(this.awaitingChanges);
		this.awaitingChanges = undefined;
		if (this.state === 'joined' || this.state === 'joining') {
			this.state = 'errored';
			this.statusCallback?.('CHANNEL_ERROR', new Error('the realtime connection dropped; rejoining'));
		}
	}

	private async attach(): Promise<void> {
		this.state = 'joining';
		this.earlyChanges = undefined;
		const joinRef = this.client.nextRef();
		this.joinRef = joinRef;
		const changes = this.bindings.filter((binding) => binding.type === 'postgres_changes');
		const config = this.options.config ?? {};
		const payload = {
			config: {
				broadcast: { self: false, ack: false, ...this.signalOptions() },
				presence: {
					key: this.rosterOptions()?.key ?? '',
					enabled: this.rosterOptions()?.enabled ?? this.bindings.some((binding) => binding.type === 'presence')
				},
				postgres_changes: changes.map((binding) => binding.filter),
				private: config.private ?? false
			},
			access_token: await this.client.token()
		};
		if (this.joinRef !== joinRef || !this.wanted) {
			return;
		}
		const reply = await this.client.request({ topic: this.topic, event: 'phx_join', payload, ref: joinRef, join_ref: joinRef });
		if (this.joinRef !== joinRef || !this.wanted) {
			return;
		}
		if (reply.status === 'ok') {
			const granted = (reply.response.postgres_changes ?? []) as (PostgresChangesFilter & { id: number })[];
			for (let i = 0; i < changes.length; i++) {
				const server = granted[i];
				const asked = changes[i].filter as unknown as PostgresChangesFilter;
				if (!server || server.event !== asked.event || server.schema !== asked.schema || (server.table ?? undefined) !== (asked.table ?? undefined) || (server.filter ?? undefined) !== (asked.filter ?? undefined)) {
					this.state = 'errored';
					this.wanted = false;
					void this.client.request({ topic: this.topic, event: 'phx_leave', payload: {}, ref: null, join_ref: joinRef });
					this.statusCallback?.('CHANNEL_ERROR', new Error('the server granted different table changes than were asked for'));
					return;
				}
				changes[i].id = server.id;
			}
			this.state = 'joined';
			this.rejoinTries = 0;
			this.retrack();
			if (changes.length === 0) {
				this.statusCallback?.('SUBSCRIBED');
				return;
			}
			// The join reply comes BEFORE Realtime has started capturing this channel's table
			// changes; that is announced a moment later as a `system` message. A row written in
			// between is never delivered, so SUBSCRIBED waits for it, and it means "every change
			// from now on arrives". A server that never says it is not left hanging.
			clearTimeout(this.awaitingChanges);
			this.awaitingChanges = setTimeout(() => this.changesLive(null), this.client.timeoutMs);
			unref(this.awaitingChanges);
			if (this.earlyChanges !== undefined) {
				this.changesLive(this.earlyChanges);
			}
			return;
		}
		this.state = 'errored';
		if (reply.status === 'timeout') {
			this.statusCallback?.('TIMED_OUT');
		} else {
			const reason = reply.response.reason;
			this.statusCallback?.('CHANNEL_ERROR', new Error(typeof reason === 'string' ? reason : JSON.stringify(reply.response)));
		}
		this.scheduleRejoin();
	}

	private changesLive(refusal: string | null): void {
		clearTimeout(this.awaitingChanges);
		this.awaitingChanges = undefined;
		if (this.state !== 'joined') {
			return;
		}
		if (refusal === null) {
			this.statusCallback?.('SUBSCRIBED');
			return;
		}
		this.state = 'errored';
		this.statusCallback?.('CHANNEL_ERROR', new Error(refusal));
		this.scheduleRejoin();
	}

	private scheduleRejoin(): void {
		clearTimeout(this.rejoinTimer);
		if (!this.wanted) {
			return;
		}
		this.rejoinTimer = setTimeout(() => {
			this.rejoinTries += 1;
			if (this.wanted && this.client.isConnected()) {
				void this.attach();
			}
		}, backoff(this.rejoinTries));
	}

	/** @internal */
	receive(frame: Frame): void {
		// A frame for an earlier join of this topic belongs to a channel that no longer exists.
		if (frame.join_ref && this.joinRef && frame.join_ref !== this.joinRef && frame.event.startsWith('phx_')) {
			return;
		}
		switch (frame.event) {
			case 'phx_reply':
				return;
			case 'phx_error':
				if (this.state === 'joined' || this.state === 'joining') {
					this.state = 'errored';
					this.statusCallback?.('CHANNEL_ERROR', new Error('the channel crashed on the server; rejoining'));
					this.scheduleRejoin();
				}
				return;
			case 'phx_close':
				this.state = 'closed';
				if (this.wanted) {
					this.statusCallback?.('CLOSED');
					this.scheduleRejoin();
				}
				return;
			case 'broadcast':
				this.dispatch('broadcast', (filter) => filter.event === '*' || filter.event === frame.payload.event, frame.payload);
				return;
			case 'presence_state':
				this.presenceSync(frame.payload as Record<string, { metas: Record<string, unknown>[] }>);
				return;
			case 'presence_diff':
				this.presenceDiff(frame.payload as { joins: Record<string, { metas: Record<string, unknown>[] }>; leaves: Record<string, { metas: Record<string, unknown>[] }> });
				return;
			case 'system':
				if (frame.payload.extension === 'postgres_changes') {
					const refusal = frame.payload.status === 'ok' ? null : String(frame.payload.message ?? 'Realtime refused the table changes');
					if (this.awaitingChanges !== undefined) {
						this.changesLive(refusal);
					} else if (this.state === 'joining') {
						this.earlyChanges = refusal;
					}
				}
				this.dispatch('system', () => true, frame.payload);
				return;
			case 'postgres_changes':
				this.postgresChange(frame.payload as { ids?: number[]; data: Record<string, unknown> });
				return;
			default:
				this.dispatch(frame.event, () => true, frame.payload);
		}
	}

	private dispatch(type: string, matches: (filter: Record<string, unknown>) => boolean, payload: unknown): void {
		for (const binding of this.bindings) {
			if (binding.type === type && matches(binding.filter)) {
				(binding.callback as (payload: unknown) => void)(payload);
			}
		}
	}

	private postgresChange(message: { ids?: number[]; data: Record<string, unknown> }): void {
		const data = message.data;
		const change: PostgresChangesPayload = {
			schema: String(data.schema),
			table: String(data.table),
			commit_timestamp: String(data.commit_timestamp),
			eventType: (data.type ?? data.eventType) as PostgresChangesPayload['eventType'],
			new: (data.record ?? {}) as Record<string, unknown>,
			old: (data.old_record ?? {}) as Record<string, unknown>,
			errors: (data.errors ?? null) as string[] | null
		};
		for (const binding of this.bindings) {
			if (binding.type !== 'postgres_changes') {
				continue;
			}
			const filter = binding.filter as unknown as PostgresChangesFilter;
			const byId = message.ids !== undefined && binding.id !== undefined;
			const matches = byId
				? message.ids!.includes(binding.id!)
				: (filter.event === '*' || filter.event === change.eventType) &&
					filter.schema === change.schema &&
					(filter.table === undefined || filter.table === '*' || filter.table === change.table);
			if (matches) {
				(binding.callback as (payload: PostgresChangesPayload) => void)(change);
			}
		}
	}

	private presenceSync(state: Record<string, { metas: Record<string, unknown>[] }>): void {
		const next: Record<string, Presence[]> = {};
		for (const [key, entry] of Object.entries(state)) {
			next[key] = entry.metas.map(toPresence);
		}
		const previous = this.presence;
		this.presence = next;
		for (const [key, presences] of Object.entries(next)) {
			const known = new Set((previous[key] ?? []).map((p) => p.presence_ref));
			const joined = presences.filter((p) => !known.has(p.presence_ref));
			if (joined.length > 0) {
				this.emitPresence({ event: 'join', key, currentPresences: previous[key] ?? [], newPresences: joined });
			}
		}
		for (const [key, presences] of Object.entries(previous)) {
			const still = new Set((next[key] ?? []).map((p) => p.presence_ref));
			const left = presences.filter((p) => !still.has(p.presence_ref));
			if (left.length > 0) {
				this.emitPresence({ event: 'leave', key, currentPresences: next[key] ?? [], leftPresences: left });
			}
		}
		this.dispatch('presence', (filter) => filter.event === 'sync', undefined);
	}

	private presenceDiff(diff: { joins: Record<string, { metas: Record<string, unknown>[] }>; leaves: Record<string, { metas: Record<string, unknown>[] }> }): void {
		for (const [key, entry] of Object.entries(diff.joins ?? {})) {
			const current = this.presence[key] ?? [];
			const incoming = entry.metas.map(toPresence);
			const refs = new Set(incoming.map((p) => p.presence_ref));
			this.presence[key] = [...current.filter((p) => !refs.has(p.presence_ref)), ...incoming];
			this.emitPresence({ event: 'join', key, currentPresences: current, newPresences: incoming });
		}
		for (const [key, entry] of Object.entries(diff.leaves ?? {})) {
			const leaving = entry.metas.map(toPresence);
			const refs = new Set(leaving.map((p) => p.presence_ref));
			const remaining = (this.presence[key] ?? []).filter((p) => !refs.has(p.presence_ref));
			if (remaining.length > 0) {
				this.presence[key] = remaining;
			} else {
				delete this.presence[key];
			}
			this.emitPresence({ event: 'leave', key, currentPresences: remaining, leftPresences: leaving });
		}
		this.dispatch('presence', (filter) => filter.event === 'sync', undefined);
	}

	private emitPresence(event: PresenceJoin | PresenceLeave): void {
		this.dispatch('presence', (filter) => filter.event === event.event, event);
	}
}

function toPresence(meta: Record<string, unknown>): Presence {
	const { phx_ref, phx_ref_prev: _previous, ...rest } = meta;
	return { ...rest, presence_ref: String(phx_ref) };
}

// The 0.3.x names, each the same function as its new one, kept for 0.4.x.

RealtimeClient.prototype.channel = RealtimeClient.prototype.topic;
RealtimeChannel.prototype.on = RealtimeChannel.prototype.listen as unknown as RealtimeChannel['on'];
RealtimeChannel.prototype.subscribe = RealtimeChannel.prototype.join;
RealtimeChannel.prototype.send = RealtimeChannel.prototype.signal;
RealtimeChannel.prototype.track = RealtimeChannel.prototype.announce;
